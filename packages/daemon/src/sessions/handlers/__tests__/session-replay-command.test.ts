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
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import { withClientReplayScriptSources } from '@agent-device/replay-port/replay-script-source-fixtures';
import { makeIosSession } from '../../../__tests__/support/session-factories.ts';
import {
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
} from '../../../__tests__/support/handlers/session-command-harness.ts';
import type { EndedLeaseLedger } from '../../../core/request-ended-leases.ts';

test('replay test handler threads the complete video owner into the application command', async () => {
  const root = mkdtempForTestSync('agent-device-replay-handler-video-');
  const params: SessionCommandParams = {
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
