import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { LeaseRegistry } from '../../../resources/lease-registry.ts';
import {
  unavailableBindDevice,
  unavailableBindExactDevice,
} from '../../../__tests__/support/unavailable-device-runtime-gateway.ts';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { platformResourceCleanupFixture } from '../../../__tests__/support/platform-resource-cleanup-fixture.ts';
import type { SessionCommandParams } from '../session-command-input.ts';
import { handleReplayTestCommand } from '../session-replay-command.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { makeSessionStore } from '../../../__tests__/support/handlers/session-test-harness.ts';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import { withClientReplayScriptSources } from '../../../__tests__/support/replay-script-source-fixture.ts';
import { makeIosSession } from '../../../__tests__/support/session-factories.ts';
import {
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
} from '../../../__tests__/support/handlers/session-command-harness.ts';
import type { EndedLeaseLedger } from '../../../core/request-ended-leases.ts';

test('replay test handler threads the complete video owner into the application command', async () => {
  const root = mkdtempForTestSync('agent-device-replay-handler-video-');
  const params: SessionCommandParams = {
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: [path.join(root, 'suite.ad')],
      flags: { recordVideo: true },
      meta: { cwd: root, requestId: 'replay-handler-video' },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore: makeSessionStore(),
    platformServices: daemonPlatformServicesFixture(),
    leaseRegistry: new LeaseRegistry(),
    invoke: async () => ({ ok: true, data: {} }),
    bindDevice: unavailableBindDevice,
    bindExactDevice: unavailableBindExactDevice,
    screenRecordingAdmissionLedger: createScreenRecordingAdmissionLedger(),
    requestScope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    retainDeviceExecutionLock: async () => {},
    throwIfCanceled: () => {},
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained' as const,
      reason: 'handler-test' as const,
    }),
    platformResourceCleanup: platformResourceCleanupFixture(),
  };

  const response = await handleReplayTestCommand(params);

  if (!response || response.ok) throw new Error('Expected a missing-source error response');
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).not.toContain('Screen-recording runtime is not configured');
});

test('replay test session cleanup reports the lease it ended on the test request', async () => {
  const root = mkdtempForTestSync('agent-device-replay-handler-ended-lease-');
  const scriptPath = path.join(root, 'opens.ad');
  fs.writeFileSync(scriptPath, 'context platform=ios\nopen "com.example.app"\n');
  const sessionStore = makeSessionStore();
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  const endedLeases: EndedLeaseLedger = [];
  const wireReq = await withClientReplayScriptSources({
    token: 'token',
    session: 'default',
    command: 'test',
    positionals: [scriptPath],
    flags: {},
    meta: { cwd: root, requestId: 'replay-handler-ended-lease' },
  });
  const params: SessionCommandParams = {
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    req: { ...wireReq, internal: { endedLeases } },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    platformServices: daemonPlatformServicesFixture(),
    leaseRegistry,
    invoke: async (nestedReq) => {
      if (nestedReq.command === 'open' && nestedReq.session) {
        sessionStore.publish(
          nestedReq.session,
          makeIosSession(nestedReq.session, {
            lease: { leaseId: lease.leaseId, tenantId: lease.tenantId, runId: lease.runId },
          }),
        );
      }
      return { ok: true, data: {} };
    },
    inspectFacts: mockInspectDeviceRuntimeFacts,
    bindDevice: mockBindDeviceRuntime,
    bindExactDevice: unavailableBindExactDevice,
    screenRecordingAdmissionLedger: createScreenRecordingAdmissionLedger(),
    requestScope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    retainDeviceExecutionLock: async () => {},
    throwIfCanceled: () => {},
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained' as const,
      reason: 'handler-test' as const,
    }),
    platformResourceCleanup: platformResourceCleanupFixture(),
  };

  const response = await handleReplayTestCommand(params);

  expect(response).toMatchObject({ ok: true });
  expect(endedLeases).toEqual([{ leaseId: lease.leaseId, outcome: 'released' }]);
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});

test('replay test handler releases an unheld suite request lease in finally when runReplayTestCommand throws (#5129)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-handler-throw-lease-');
  const scriptPath = path.join(root, 'opens.ad');
  fs.writeFileSync(scriptPath, 'context platform=ios\nopen "com.example.app"\n');
  const sessionStore = makeSessionStore();
  const leaseRegistry = new LeaseRegistry();
  const releaseCalls: string[] = [];
  const lease = leaseRegistry.allocateLease({
    tenantId: 'proxy',
    runId: 'run-5129-throw',
    leaseProvider: 'proxy',
    leaseBackend: 'ios-instance',
    clientId: 'client-5129',
    deviceKey: 'ios:mobile:sim-1',
  });
  const endedLeases: EndedLeaseLedger = [];
  const wireReq = await withClientReplayScriptSources({
    token: 'token',
    session: 'default',
    command: 'test',
    positionals: [scriptPath],
    flags: { platform: 'ios', udid: 'sim-1' },
    meta: {
      cwd: root,
      requestId: 'replay-handler-throw-ended-lease',
      leaseId: lease.leaseId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
      tenantId: lease.tenantId,
      runId: lease.runId,
      clientId: lease.clientId,
      deviceKey: lease.deviceKey,
    },
  });
  const params: SessionCommandParams = {
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    req: { ...wireReq, internal: { endedLeases, admittedLease: lease } },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    platformServices: daemonPlatformServicesFixture(),
    leaseRegistry,
    leaseLifecycleProvider: {
      async release(releasedLease) {
        releaseCalls.push(releasedLease.leaseId);
        return undefined;
      },
    },
    invoke: async (nestedReq) => {
      if (nestedReq.command === 'open' && nestedReq.session) {
        sessionStore.publish(
          nestedReq.session,
          makeIosSession(nestedReq.session, { appBundleId: 'com.example.app' }),
        );
      }
      return { ok: true, data: {} };
    },
    inspectFacts: async () => {
      throw new Error('simulated close cleanup failure');
    },
    bindDevice: mockBindDeviceRuntime,
    bindExactDevice: unavailableBindExactDevice,
    screenRecordingAdmissionLedger: createScreenRecordingAdmissionLedger(),
    requestScope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    retainDeviceExecutionLock: async () => {},
    throwIfCanceled: () => {},
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained' as const,
      reason: 'handler-test' as const,
    }),
    platformResourceCleanup: platformResourceCleanupFixture(),
  };

  const response = await handleReplayTestCommand(params);

  expect(response).toMatchObject({ ok: true, data: { total: 1, passed: 0, failed: 1 } });
  expect(releaseCalls).toEqual([lease.leaseId]);
  expect(endedLeases).toEqual([{ leaseId: lease.leaseId, outcome: 'released' }]);
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});

test('replay test handler releases an unheld suite request lease in finally if splitReplayCommandRequest rejects (#5129)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-handler-throw-before-');
  const leaseRegistry = new LeaseRegistry();
  const releaseCalls: string[] = [];
  const lease = leaseRegistry.allocateLease({
    tenantId: 'proxy',
    runId: 'run-5129-reject',
    leaseProvider: 'proxy',
    leaseBackend: 'ios-instance',
    clientId: 'client-5129',
    deviceKey: 'ios:mobile:sim-1',
  });
  const endedLeases: EndedLeaseLedger = [];
  const bundle = {
    entry: path.join(root, 'opens.ad'),
    content: 'context platform=ios\nopen "com.example.app"\n',
  };
  Object.defineProperty(bundle, 'entry', {
    enumerable: true,
    get() {
      throw new Error('simulated suite setup throw');
    },
  });
  const req: SessionCommandParams['req'] = {
    token: 'token',
    session: 'default',
    command: 'test',
    positionals: [root],
    flags: {
      platform: 'ios',
      udid: 'sim-1',
      replayBackend: 'maestro',
      replayScriptSources: [bundle as never],
    },
    meta: {
      cwd: root,
      requestId: 'replay-handler-reject-ended-lease',
      leaseId: lease.leaseId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
      tenantId: lease.tenantId,
      runId: lease.runId,
      clientId: lease.clientId,
      deviceKey: lease.deviceKey,
    },
    internal: { endedLeases, admittedLease: lease },
  };

  await expect(
    handleReplayTestCommand({
      host: createTestHostEnvironment(),
      createCommandSurface: fakeCreateCommandSurface,
      req,
      sessionName: 'default',
      logPath: path.join(root, 'daemon.log'),
      sessionStore: makeSessionStore(),
      platformServices: daemonPlatformServicesFixture(),
      leaseRegistry,
      leaseLifecycleProvider: {
        async release(releasedLease) {
          releaseCalls.push(releasedLease.leaseId);
          return undefined;
        },
      },
      invoke: async () => ({ ok: true, data: {} }),
      inspectFacts: mockInspectDeviceRuntimeFacts,
      bindDevice: unavailableBindDevice,
      bindExactDevice: unavailableBindExactDevice,
      screenRecordingAdmissionLedger: createScreenRecordingAdmissionLedger(),
      requestScope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
      retainDeviceExecutionLock: async () => {},
      throwIfCanceled: () => {},
      reconcileOrphanedDeviceClaim: async () => ({
        status: 'retained' as const,
        reason: 'handler-test' as const,
      }),
      platformResourceCleanup: platformResourceCleanupFixture(),
    }),
  ).rejects.toThrow('simulated suite setup throw');
  expect(releaseCalls).toEqual([lease.leaseId]);
  expect(endedLeases).toEqual([{ leaseId: lease.leaseId, outcome: 'released' }]);
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});
