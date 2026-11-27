import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { legacyDispatchCapture } from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';

import path from 'node:path';
import { getResolveTargetDeviceMock } from '../../__tests__/support/request-router-dispatch-mocks.ts';
import { createTouchCommandSurface } from '../../__tests__/support/touch-command-surface-fake.ts';
const testCreateCommandSurface = createTouchCommandSurface();
import type {
  PlatformProviderRequestContext,
  RequestPlatformProviderScope,
  RequestPlatformProviders,
} from '@agent-device/contracts/platform-providers';

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, prewarmIosRunnerSession: vi.fn() };
});

vi.mock('@agent-device/platform-apple/app-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-resolution')>();
  return {
    ...actual,
    resolveIosApp: vi.fn(async () => 'com.example.app'),
    resolveIosSimulatorDeepLinkBundleId: vi.fn(async () => undefined),
  };
});

import {
  IOS_SIMULATOR,
  mkdtempForTestSync,
  createTestHostEnvironment,
  pinOwnProcessStartTime,
} from '@agent-device/test-kit';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { inspectDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import * as hostProcess from '@agent-device/host-kit/process';
import {
  createRequestHandler,
  gestureRuntimeSpies,
  lifecycleDeviceRuntimeGateway,
  systemRuntimeSpies,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
// Readiness is package-owned; hold the open at the fixture's platform-neutral readiness gate.
import { awaitFixtureReadiness } from '../../__tests__/support/application-lifecycle-runtime-fixture.ts';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
const mockAwaitFixtureReadiness = vi.mocked(awaitFixtureReadiness);

pinOwnProcessStartTime(hostProcess);

beforeEach(() => {
  gestureRuntimeSpies.scrollDirection.mockClear();
  systemRuntimeSpies.appSwitcher.mockClear();
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  mockResolveTargetDevice.mockReset();
  mockResolveTargetDevice.mockResolvedValue(IOS_SIMULATOR);
  mockAwaitFixtureReadiness.mockReset();
  mockAwaitFixtureReadiness.mockResolvedValue(undefined);
});

test('replay runs active-session actions inside the parent request provider scope', async () => {
  const root = mkdtempForTestSync('agent-device-replay-scope-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'app-switcher\nscroll down\n');
  const sessionStore = makeSessionStore('agent-device-replay-scope-');
  sessionStore.publish('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  const providerScopes = requestPlatformProvidersFake();

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    requestPlatformProviders: providerScopes.providers,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [replayPath],
    meta: { cwd: root, requestId: 'replay-scope-1', sessionExplicit: true },
  });

  expect(response).toMatchObject({ ok: true });
  // Both actions now reach bound operations — `app-switcher` through R56, `scroll down` through
  // R53 — so the flow drives the runtime gateway twice and the legacy dispatcher not at all.
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
  expect(systemRuntimeSpies.appSwitcher).toHaveBeenCalledTimes(1);
  expect(gestureRuntimeSpies.scrollDirection).toHaveBeenCalledTimes(1);
  expect(providerScopes.contexts).toHaveLength(1);
  expect(providerScopes.contexts[0]).toMatchObject({
    requestId: 'replay-scope-1',
    session: { name: 'default', device: { platform: 'apple' } },
  });
});

test('replay routes session-changing actions through the full request path', async () => {
  const root = mkdtempForTestSync('agent-device-replay-full-route-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'runtime set --platform ios --metro-host localhost\napp-switcher\n');
  const sessionStore = makeSessionStore('agent-device-replay-full-route-');
  sessionStore.publish('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  const providerScopes = requestPlatformProvidersFake();

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    requestPlatformProviders: providerScopes.providers,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [replayPath],
    meta: { cwd: root, requestId: 'replay-scope-2', sessionExplicit: true },
  });

  expect(response).toMatchObject({ ok: true });
  // `app-switcher` reaches its bound operation since R56; `runtime set` mutates session state and
  // never dispatched, so the legacy dispatcher sees neither action.
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
  expect(systemRuntimeSpies.appSwitcher).toHaveBeenCalledTimes(1);
  expect(providerScopes.contexts).toHaveLength(2);
  expect(providerScopes.contexts.every((context) => context.session?.name === 'default')).toBe(
    true,
  );
});

test('session list includes a cwd-scoped session opened by replay', async () => {
  const root = mkdtempForTestSync('agent-device-replay-open-scope-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "com.example.app"\n');
  const sessionStore = makeSessionStore('agent-device-replay-open-scope-');

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const replayResponse = await handler({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [replayPath],
    flags: { platform: 'ios' },
    meta: { cwd: root, requestId: 'replay-open-scope', deviceKey: 'test:sim-1' },
  });
  expect(replayResponse).toMatchObject({ ok: true });
  const listResponse = await handler({
    token: 'test-token',
    session: 'default',
    command: 'session_list',
    positionals: [],
    meta: { cwd: root, requestId: 'session-list-scope' },
  });

  expect(listResponse).toMatchObject({
    ok: true,
    data: {
      sessions: [
        expect.objectContaining({
          // A platform-selecting request addresses that platform's own implicit session (#2580).
          name: expect.stringMatching(/^cwd:[a-f0-9]+:ios$/),
        }),
      ],
    },
  });
});

test('fresh replay retains a dynamically selected device through finalization', async () => {
  const root = mkdtempForTestSync('agent-device-replay-device-lock-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(
    replayPath,
    'runtime set --platform ios --metro-host localhost\nopen "demo://checkout"\n',
  );
  const sessionStore = makeSessionStore('agent-device-replay-device-lock-');
  const leaseRegistry = new LeaseRegistry();
  let releaseReadiness: () => void = () => {};
  const readinessReleased = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  let markReadinessEntered: () => void = () => {};
  const readinessEntered = new Promise<void>((resolve) => {
    markReadinessEntered = resolve;
  });
  mockAwaitFixtureReadiness.mockImplementation(async () => {
    markReadinessEntered();
    await readinessReleased;
  });

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  const replayResponse = handler({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [replayPath],
    flags: { platform: 'ios' },
    meta: { cwd: root, requestId: 'replay-device-lock', deviceKey: 'test:sim-1' },
  });
  await readinessEntered;

  sessionStore.publish('external', makeIosSession('external'));
  let externalRequestSettled = false;
  const externalResponse = handler({
    token: 'test-token',
    session: 'external',
    command: 'home',
    positionals: [],
    meta: {
      cwd: root,
      requestId: 'external-device-command',
      sessionExplicit: true,
    },
  }).finally(() => {
    externalRequestSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(externalRequestSettled).toBe(false);

  releaseReadiness();
  await expect(replayResponse).resolves.toMatchObject({ ok: true });
  await externalResponse;
  expect(externalRequestSettled).toBe(true);
});

test('test runs a one-case suite whose script leaves a session open, passes, and closes the session', async () => {
  const root = mkdtempForTestSync('agent-device-replay-test-leak-');
  const scriptPath = path.join(root, '01-case.ad');
  fs.writeFileSync(scriptPath, 'context platform=ios\nopen "com.example.app"\n');
  const sessionStore = makeSessionStore('agent-device-replay-test-leak-');

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'test',
    positionals: [root],
    flags: { platform: 'ios' },
    meta: { cwd: root, requestId: 'suite-unclosed-session' },
  });

  expect(response).toMatchObject({
    ok: true,
    data: expect.objectContaining({
      passed: 1,
      failed: 0,
    }),
  });
  expect(sessionStore.listRefs()).toHaveLength(0);
});

test('test --maestro borrows the outer session device and claim without releasing either (#5129)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-test-outer-open-');
  const claimsDir = mkdtempForTestSync('agent-device-replay-test-outer-claims-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  const flowPath = path.join(root, 'first-launch.yaml');
  fs.writeFileSync(
    flowPath,
    ['appId: com.example.app', 'name: First launch', '---', '- launchApp', ''].join('\n'),
  );
  const sessionStore = makeSessionStore('agent-device-replay-test-outer-open-');

  try {
    const handler = createRequestHandler({
      host: createTestHostEnvironment(),
      createCommandSurface: testCreateCommandSurface,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact: () => 'artifact-id',
    });

    const openResponse = await handler({
      token: 'test-token',
      session: 'default',
      command: 'open',
      positionals: ['com.example.app'],
      flags: { platform: 'ios' },
      meta: { cwd: root, requestId: 'outer-open-5129' },
    });
    expect(openResponse.ok).toBe(true);
    const claimsBefore = inspectDeviceClaims({ udid: IOS_SIMULATOR.id }, process.env);
    expect(claimsBefore).toHaveLength(1);
    const ownerTokenBefore = claimsBefore[0]?.claim?.ownerToken;

    const testResponse = await handler({
      token: 'test-token',
      session: 'default',
      command: 'test',
      positionals: [flowPath],
      flags: { platform: 'ios', replayBackend: 'maestro' },
      meta: { cwd: root, requestId: 'suite-outer-open-5129' },
    });

    expect(testResponse).toMatchObject({
      ok: true,
      data: expect.objectContaining({
        total: 1,
        passed: 1,
        failed: 0,
      }),
    });
    // Attempt cleanup retired the temporary attempt session without disturbing the outer session or its disk claim.
    expect(sessionStore.listRefs()).toHaveLength(1);
    const claimsAfter = inspectDeviceClaims({ udid: IOS_SIMULATOR.id }, process.env);
    expect(claimsAfter).toHaveLength(1);
    expect(claimsAfter[0]?.claim?.ownerToken).toBe(ownerTokenBefore);
  } finally {
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test still refuses DEVICE_IN_USE when another session holds the device (#5129)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-test-foreign-conflict-');
  const otherRoot = mkdtempForTestSync('agent-device-replay-test-foreign-holder-');
  const claimsDir = mkdtempForTestSync('agent-device-replay-test-foreign-claims-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  const flowPath = path.join(root, 'first-launch.yaml');
  fs.writeFileSync(flowPath, ['appId: com.example.app', '---', '- launchApp', ''].join('\n'));
  const sessionStore = makeSessionStore('agent-device-replay-test-foreign-');

  try {
    const handler = createRequestHandler({
      host: createTestHostEnvironment(),
      createCommandSurface: testCreateCommandSurface,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact: () => 'artifact-id',
    });

    const foreignOpen = await handler({
      token: 'test-token',
      session: 'foreign',
      command: 'open',
      positionals: ['com.example.app'],
      flags: { platform: 'ios' },
      meta: { cwd: otherRoot, requestId: 'foreign-open-5129' },
    });
    expect(foreignOpen.ok).toBe(true);

    const testResponse = await handler({
      token: 'test-token',
      session: 'caller',
      command: 'test',
      positionals: [flowPath],
      flags: { platform: 'ios', replayBackend: 'maestro' },
      meta: { cwd: root, requestId: 'caller-test-5129' },
    });

    expect(testResponse.ok).toBe(true);
    if (!testResponse.ok) return;
    expect(testResponse.data).toMatchObject({ total: 1, passed: 0, failed: 1 });
    const tests = testResponse.data?.tests as Array<{
      error?: { details?: { divergence?: { cause?: { code?: string; message?: string } } } };
    }>;
    expect(tests[0]?.error?.details?.divergence?.cause?.code).toBe('DEVICE_IN_USE');
    expect(tests[0]?.error?.details?.divergence?.cause?.message).toMatch(/foreign/);
  } finally {
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two-script test with a request lease and no open ends the lease once and reports endedLeases once (#5129)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-test-request-lease-end-');
  fs.writeFileSync(path.join(root, '01-first.ad'), 'context platform=ios\nwait 1\n');
  fs.writeFileSync(path.join(root, '02-second.ad'), 'context platform=ios\nwait 1\n');
  const sessionStore = makeSessionStore('agent-device-replay-test-request-lease-end-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'proxy',
    runId: 'run-5129-request-only',
    leaseProvider: 'proxy',
    leaseBackend: 'ios-instance',
    clientId: 'client-5129',
    deviceKey: `ios:mobile:${IOS_SIMULATOR.id}`,
  });
  const releaseCalls: string[] = [];

  try {
    const handler = createRequestHandler({
      host: createTestHostEnvironment(),
      createCommandSurface: testCreateCommandSurface,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry,
      leaseLifecycleProvider: {
        async release(releasedLease) {
          releaseCalls.push(releasedLease.leaseId);
          return undefined;
        },
      },
      deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact: () => 'artifact-id',
    });

    const response = await handler({
      token: 'test-token',
      session: 'default',
      command: 'test',
      positionals: [root],
      flags: {
        platform: 'ios',
        leaseId: lease.leaseId,
        leaseBackend: lease.backend,
        udid: IOS_SIMULATOR.id,
      },
      meta: {
        cwd: root,
        requestId: 'suite-request-lease-end-5129',
        leaseId: lease.leaseId,
        leaseBackend: lease.backend,
        leaseProvider: lease.leaseProvider,
        tenantId: lease.tenantId,
        runId: lease.runId,
        clientId: lease.clientId,
        deviceKey: lease.deviceKey,
      },
    });

    expect(response.ok ? undefined : response.error).toBeUndefined();
    expect(response).toMatchObject({
      ok: true,
      data: expect.objectContaining({
        total: 2,
        passed: 2,
        failed: 0,
        endedLeases: [{ leaseId: lease.leaseId, outcome: 'released' }],
      }),
    });
    expect(releaseCalls).toEqual([lease.leaseId]);
    expect(
      leaseRegistry.getLease({
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        clientId: lease.clientId,
        leaseBackend: lease.backend,
        leaseProvider: lease.leaseProvider,
        deviceKey: lease.deviceKey,
      }),
    ).toBeUndefined();
    expect(sessionStore.listRefs()).toHaveLength(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two-script test with wait then open ends the unheld request lease once without duplicate endedLeases (#5129)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-test-wait-then-open-');
  fs.writeFileSync(path.join(root, '01-first.ad'), 'context platform=ios\nwait 1\n');
  fs.writeFileSync(
    path.join(root, '02-second.ad'),
    'context platform=ios\nopen "com.example.app"\n',
  );
  const sessionStore = makeSessionStore('agent-device-replay-test-wait-then-open-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'proxy',
    runId: 'run-5129-mixed',
    leaseProvider: 'proxy',
    leaseBackend: 'ios-instance',
    clientId: 'client-5129',
    deviceKey: `ios:mobile:${IOS_SIMULATOR.id}`,
  });
  const releaseCalls: string[] = [];

  try {
    const handler = createRequestHandler({
      host: createTestHostEnvironment(),
      createCommandSurface: testCreateCommandSurface,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry,
      leaseLifecycleProvider: {
        async release(releasedLease) {
          releaseCalls.push(releasedLease.leaseId);
          return undefined;
        },
      },
      deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact: () => 'artifact-id',
    });

    const response = await handler({
      token: 'test-token',
      session: 'default',
      command: 'test',
      positionals: [root],
      flags: {
        platform: 'ios',
        leaseId: lease.leaseId,
        leaseBackend: lease.backend,
        udid: IOS_SIMULATOR.id,
      },
      meta: {
        cwd: root,
        requestId: 'suite-mixed-lease-end-5129',
        leaseId: lease.leaseId,
        leaseBackend: lease.backend,
        leaseProvider: lease.leaseProvider,
        tenantId: lease.tenantId,
        runId: lease.runId,
        clientId: lease.clientId,
        deviceKey: lease.deviceKey,
      },
    });

    expect(response.ok ? undefined : response.error).toBeUndefined();
    expect(response).toMatchObject({
      ok: true,
      data: expect.objectContaining({
        total: 2,
        passed: 2,
        failed: 0,
        endedLeases: [{ leaseId: lease.leaseId, outcome: 'released' }],
      }),
    });
    expect(releaseCalls).toEqual([lease.leaseId]);
    expect(sessionStore.listRefs()).toHaveLength(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('suite attempt cleanup keeps a shared provider lease active when an outer session holds it (#5129)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-test-lease-retention-');
  fs.writeFileSync(path.join(root, '01-case.ad'), 'context platform=ios\nopen "com.example.app"\n');
  fs.writeFileSync(path.join(root, '02-case.ad'), 'context platform=ios\nopen "com.example.app"\n');
  const sessionStore = makeSessionStore('agent-device-replay-test-lease-retention-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'proxy',
    runId: 'run-5129',
    leaseProvider: 'proxy',
    leaseBackend: 'ios-instance',
    clientId: 'client-5129',
    deviceKey: `ios:mobile:${IOS_SIMULATOR.id}`,
  });
  const releaseCalls: string[] = [];

  try {
    const handler = createRequestHandler({
      host: createTestHostEnvironment(),
      createCommandSurface: testCreateCommandSurface,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry,
      leaseLifecycleProvider: {
        async release(releasedLease) {
          releaseCalls.push(releasedLease.leaseId);
          return undefined;
        },
      },
      deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact: () => 'artifact-id',
    });

    const leaseFlags = {
      platform: 'ios' as const,
      leaseId: lease.leaseId,
      leaseBackend: lease.backend,
      udid: IOS_SIMULATOR.id,
    };
    const leaseMeta = {
      cwd: root,
      leaseId: lease.leaseId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
      tenantId: lease.tenantId,
      runId: lease.runId,
      clientId: lease.clientId,
      deviceKey: lease.deviceKey,
    };
    const outerOpen = await handler({
      token: 'test-token',
      session: 'default',
      command: 'open',
      positionals: ['com.example.app'],
      flags: leaseFlags,
      meta: { ...leaseMeta, requestId: 'outer-open-lease-retention-5129' },
    });
    expect(outerOpen.ok ? undefined : outerOpen.error).toBeUndefined();

    const response = await handler({
      token: 'test-token',
      session: 'default',
      command: 'test',
      positionals: [root],
      flags: leaseFlags,
      meta: { ...leaseMeta, requestId: 'suite-lease-retention-5129' },
    });

    expect(response.ok ? undefined : response.error).toBeUndefined();
    expect(response).toMatchObject({
      ok: true,
      data: expect.objectContaining({ total: 2, passed: 2, failed: 0 }),
    });
    if (!response.ok) return;
    expect(response.data?.endedLeases).toBeUndefined();
    expect(releaseCalls).toEqual([]);
    expect(
      leaseRegistry.getLease({
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        clientId: lease.clientId,
        leaseBackend: lease.backend,
        leaseProvider: lease.leaseProvider,
        deviceKey: lease.deviceKey,
      }),
    ).toBeDefined();
    expect(sessionStore.listRefs()).toHaveLength(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function requestPlatformProvidersFake(): {
  providers: RequestPlatformProviders;
  contexts: PlatformProviderRequestContext[];
} {
  const contexts: PlatformProviderRequestContext[] = [];
  return {
    contexts,
    providers: {
      hasConfiguredResolvers: true,
      async run(context, task) {
        contexts.push(context);
        return await task({} satisfies RequestPlatformProviderScope);
      },
    },
  };
}
