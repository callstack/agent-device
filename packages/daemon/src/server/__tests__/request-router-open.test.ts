import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { observeBootTimeMsFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { legacyDispatchCapture } from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { test, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

import path from 'node:path';
import { getResolveTargetDeviceMock } from '../../__tests__/support/request-router-dispatch-mocks.ts';

import { replayScriptSourceBundleFor } from '../../__tests__/support/replay-script-source-fixture.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

vi.mock('../../core/device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  const startTime = 'test-process-start';
  return {
    ...actual,
    readProcessStartTime: vi.fn(() => startTime),
    // The ownership decision reads all three facts in one call, so it has to answer with the
    // same fabricated start time this fixture writes into its markers.
    readProcessIdentityFacts: vi.fn(async (pid: number) => ({
      startTime,
      command: actual.readProcessCommand(pid),
      zombie: false,
    })),
  };
});
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return {
    ...actual,
    detachIosRunnerSessionsForShutdown: vi.fn(async () => {}),
    notifyIosRunnerAppRelaunched: vi.fn(async () => {}),
    prewarmAppleRunnerCache: vi.fn(async () => {}),
    prewarmIosRunnerSession: vi.fn(async () => {}),
    prepareIosRunner: vi.fn(async () => ({
      runner: { currentUptimeMs: 42 },
      connectMs: 0,
      healthCheckMs: 0,
    })),
    resolveRunnerAppBundleId: vi.fn(() => 'com.callstack.agentdevice.runner'),
    stopIosRunnerSession: vi.fn(async () => {}),
    stopAllIosRunnerSessions: vi.fn(async () => {}),
  };
});
vi.mock('@agent-device/platform-apple/app-lifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-lifecycle')>();
  return { ...actual, closeIosApp: vi.fn(async () => {}) };
});
vi.mock('@agent-device/platform-apple/app-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-resolution')>();
  return {
    ...actual,
    resolveIosApp: vi.fn(async (_device, app) => app),
  };
});

import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { resolveRequestExecutionLockPlan } from '../request-binding.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { ensureDeviceReady } from '../../core/device/device-ready.ts';
import { awaitFixtureReadiness } from '../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { inspectDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import {
  makeAndroidDevice,
  makeIosDevice,
  openRequest,
  storedClaimUpdatedAt,
} from './request-router-open-harness.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);
const mockObserveBoot = vi.mocked(observeBootTimeMsFixture);
const mockAwaitFixtureReadiness = vi.mocked(awaitFixtureReadiness);

function createOpenHandler(
  sessionStore: ReturnType<typeof makeSessionStore>,
  leaseRegistry = new LeaseRegistry(),
  capabilities: Pick<
    Parameters<typeof createRequestHandler>[0],
    'androidObservation' | 'platformResourceCleanup'
  > = {},
) {
  return createRequestHandler({
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
    ...capabilities,
  });
}

beforeEach(() => {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  mockResolveTargetDevice.mockReset();
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
  mockAwaitFixtureReadiness.mockReset();
  mockAwaitFixtureReadiness.mockResolvedValue(undefined);
  mockObserveBoot.mockReset();
  mockObserveBoot.mockResolvedValue({ observed: false, reason: 'unobserved' });
});

// fallow-ignore-next-line complexity
test('open returns and creates the session state directory', async () => {
  const sessionStore = makeSessionStore('agent-device-router-open-');
  const device = makeIosDevice('SIM-STATE');
  mockResolveTargetDevice.mockResolvedValue(device);

  const handler = createOpenHandler(sessionStore);

  const response = await handler(openRequest('session-a', { platform: 'ios' }, 'req-open-state'));

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data?.session).toBe('session-a');
    expect(response.data?.sessionReused).toBe(false);
    expect(response.data?.sessionStateDir).toEqual(expect.stringContaining('session-a'));
    expect(response.data?.runnerLogPath).toEqual(
      path.join(String(response.data?.sessionStateDir), 'runner.log'),
    );
    expect(response.data?.requestLogPath).toEqual(
      path.join(String(response.data?.sessionStateDir), 'requests', 'req-open-state.ndjson'),
    );
    expect(response.data?.eventLogPath).toEqual(
      path.join(String(response.data?.sessionStateDir), 'events.ndjson'),
    );
    expect(fs.existsSync(String(response.data?.sessionStateDir))).toBe(true);
    // `open` records the request through `recordEvent`, which queues the event-log
    // append rather than writing it, so the path it returns can be named before the
    // file exists. Every reader of that log awaits this flush first (see
    // session-store.test.ts); asserting existence without it races the append and
    // only passes when module loading happened to drain the queue in time.
    await sessionStore.flushEvents('session-a');
    expect(fs.existsSync(String(response.data?.eventLogPath))).toBe(true);
  }
  expect(inspectDeviceClaims({ udid: device.id })[0]?.claim?.stateDir).toBe(
    sessionStore.resolveDaemonStateDir(),
  );
});

test('fresh open uses app-aware device selection for advisory locking and dispatch', async () => {
  const sessionStore = makeSessionStore('agent-device-router-open-');
  const genericDevice = makeIosDevice('SIM-GENERIC');
  const appDevice = makeIosDevice('SIM-WITH-APP');
  mockResolveTargetDevice.mockImplementation(async (_flags, options) =>
    options?.appleSimulatorAppTarget === 'com.example.demo' ? appDevice : genericDevice,
  );

  const response = await createOpenHandler(sessionStore)(
    openRequest('session-app-aware', { platform: 'ios' }, 'req-open-app-aware', {}, [
      'com.example.demo',
    ]),
  );

  expect(response.ok).toBe(true);
  expect(mockResolveTargetDevice.mock.calls).toEqual([
    [{ platform: 'ios' }, { appleSimulatorAppTarget: 'com.example.demo' }],
    [{ platform: 'ios' }, { appleSimulatorAppTarget: 'com.example.demo' }],
  ]);
  expect(sessionStore.get('session-app-aware')?.device.id).toBe(appDevice.id);
});

test('fresh replay reserves its authored app simulator before any replay step', async () => {
  const root = mkdtempForTestSync('agent-device-replay-app-lock-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(
    replayPath,
    'runtime set --platform ios --metro-port 8081\nopen com.example.demo\n',
  );
  const sessionStore = makeSessionStore('agent-device-router-replay-lock-');
  const genericDevice = makeIosDevice('SIM-GENERIC');
  const appDevice = makeIosDevice('SIM-WITH-APP');
  mockResolveTargetDevice.mockImplementation(async (_flags, options) =>
    options?.appleSimulatorAppTarget === 'com.example.demo' ? appDevice : genericDevice,
  );

  const { keys } = await resolveRequestExecutionLockPlan({
    req: {
      token: 'test-token',
      session: 'fresh-replay',
      command: 'replay',
      positionals: [replayPath],
      flags: { replayScriptSource: replayScriptSourceBundleFor(replayPath) },
      meta: { cwd: root },
    },
    sessionName: 'fresh-replay',
    sessionStore,
  });

  expect(keys).toEqual(['session:fresh-replay', 'device:SIM-WITH-APP']);
  expect(mockResolveTargetDevice).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'ios' }),
    { appleSimulatorAppTarget: 'com.example.demo' },
  );
});

test('fresh replay leaves a first deep-link open unbound when a later app target exists', async () => {
  const root = mkdtempForTestSync('agent-device-replay-deep-link-lock-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(
    replayPath,
    'runtime set --platform ios --metro-port 8081\nopen demo://checkout\nopen com.example.demo\n',
  );
  const sessionStore = makeSessionStore('agent-device-router-replay-deep-link-lock-');

  const { keys } = await resolveRequestExecutionLockPlan({
    req: {
      token: 'test-token',
      session: 'fresh-replay-deep-link',
      command: 'replay',
      positionals: [replayPath],
      flags: { replayScriptSource: replayScriptSourceBundleFor(replayPath) },
      meta: { cwd: root },
    },
    sessionName: 'fresh-replay-deep-link',
    sessionStore,
  });

  expect(keys).toEqual(['session:fresh-replay-deep-link']);
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});

test('fresh replay preserves an authored Android platform before advisory locking', async () => {
  const root = mkdtempForTestSync('agent-device-replay-android-lock-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(
    replayPath,
    'runtime set --platform android --metro-port 8081\nopen com.example.demo\n',
  );
  const sessionStore = makeSessionStore('agent-device-router-replay-android-lock-');
  const androidDevice = makeAndroidDevice('ANDROID-EMULATOR');
  mockResolveTargetDevice.mockResolvedValue(androidDevice);

  const { keys } = await resolveRequestExecutionLockPlan({
    req: {
      token: 'test-token',
      session: 'fresh-replay-android',
      command: 'replay',
      positionals: [replayPath],
      flags: { replayScriptSource: replayScriptSourceBundleFor(replayPath) },
      meta: { cwd: root },
    },
    sessionName: 'fresh-replay-android',
    sessionStore,
  });

  expect(keys).toEqual(['session:fresh-replay-android', 'device:ANDROID-EMULATOR']);
  expect(mockResolveTargetDevice).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'android' }),
    undefined,
  );
});

test('open --debug writes bounded open timing diagnostics to requestLogPath', async () => {
  const sessionStore = makeSessionStore('agent-device-router-open-');
  const device = makeIosDevice('SIM-DEBUG');
  mockResolveTargetDevice.mockResolvedValue(device);

  const handler = createOpenHandler(sessionStore);

  const response = await handler(
    openRequest('session-debug', { platform: 'ios', verbose: true }, 'req-open-debug', {
      debug: true,
    }),
  );

  expect(response.ok).toBe(true);
  if (response.ok) {
    const requestLogPath = String(response.data?.requestLogPath);
    expect(fs.existsSync(requestLogPath)).toBe(true);
    const rows = fs
      .readFileSync(requestLogPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const timingEvent = rows.find((row) => row.phase === 'open_timing');
    expect(timingEvent).toMatchObject({
      level: 'info',
      phase: 'open_timing',
      durationMs: expect.any(Number),
      data: {
        totalDurationMs: expect.any(Number),
      },
    });
  }
});

test('open stores admitted lease metadata on the session', async () => {
  const sessionStore = makeSessionStore('agent-device-router-open-');
  const leaseRegistry = new LeaseRegistry({ now: () => 1_000 });
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    deviceKey: 'ios:SIM-LEASED',
  });
  const device = makeIosDevice('SIM-LEASED');
  mockResolveTargetDevice.mockResolvedValue(device);

  const handler = createOpenHandler(sessionStore, leaseRegistry);

  const response = await handler(
    openRequest('default', { platform: 'ios' }, 'req-open-lease', {
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseId: lease.leaseId,
      sessionIsolation: 'tenant',
      leaseProvider: 'proxy',
      clientId: 'client-a',
      deviceKey: 'ios:SIM-LEASED',
      leaseBackend: 'ios-simulator',
    }),
  );

  expect(response.ok).toBe(true);
  expect(sessionStore.get('tenant-a:default')?.sessionScope).toEqual({
    kind: 'tenant',
    id: 'tenant-a',
  });
  expect(sessionStore.get('tenant-a:default')?.lease).toEqual({
    leaseId: lease.leaseId,
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-simulator',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    deviceKey: 'ios:SIM-LEASED',
    expiresAt: 61_000,
  });
});

test('proxy open without required lease metadata fails before device resolution', async () => {
  const sessionStore = makeSessionStore('agent-device-router-open-');
  const handler = createOpenHandler(sessionStore, new LeaseRegistry());

  const response = await handler(
    openRequest('default', { platform: 'ios' }, 'req-open-proxy-missing', {
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseProvider: 'proxy',
      sessionIsolation: 'tenant',
    }),
  );

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/Proxy open requires leaseId/);
  }
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
});

test.each([
  ['omitted', {}],
  ['explicit undefined', { androidObservation: undefined, platformResourceCleanup: undefined }],
])('close releases the session lease with %s fixture capabilities', async (_case, capabilities) => {
  const sessionStore = makeSessionStore('agent-device-router-open-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    clientId: 'client-a',
  });
  sessionStore.publish('default', {
    name: 'default',
    device: makeIosDevice('SIM-CLOSE'),
    createdAt: Date.now(),
    actions: [],
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      clientId: 'client-a',
    },
  });
  const handler = createOpenHandler(sessionStore, leaseRegistry, capabilities);

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'close',
    positionals: [],
    meta: { requestId: 'req-close-lease' },
  });

  expect(response.ok).toBe(true);
  expect(sessionStore.get('default')).toBeUndefined();
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});

test.each([
  ['close', []],
  ['close <app>', ['com.example.app']],
])('%s keeps a lease allocated with retainOnClose', async (_name, positionals) => {
  const sessionStore = makeSessionStore('agent-device-router-open-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    clientId: 'client-a',
    retainOnClose: true,
  });
  sessionStore.publish('default', {
    name: 'default',
    device: makeIosDevice('SIM-CLOSE-RETAIN'),
    createdAt: Date.now(),
    actions: [],
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      clientId: 'client-a',
    },
  });
  const handler = createOpenHandler(sessionStore, leaseRegistry);

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'close',
    positionals,
    meta: { requestId: 'req-close-retain-lease' },
  });

  expect(response.ok).toBe(true);
  expect(sessionStore.get('default')).toBeUndefined();
  expect(leaseRegistry.listActiveLeases()).toHaveLength(1);
  expect(
    leaseRegistry.heartbeatLease({
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      clientId: 'client-a',
    }).leaseId,
  ).toBe(lease.leaseId);
});

test('close rejects a different client before cleanup', async () => {
  const sessionStore = makeSessionStore('agent-device-router-open-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    clientId: 'client-a',
  });
  sessionStore.publish('default', {
    name: 'default',
    device: makeIosDevice('SIM-CLOSE-CLIENT'),
    createdAt: Date.now(),
    actions: [],
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      clientId: 'client-a',
    },
  });
  const handler = createOpenHandler(sessionStore, leaseRegistry);

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'close',
    positionals: [],
    meta: { requestId: 'req-close-wrong-client', clientId: 'client-b' },
  });

  expect(response.ok).toBe(false);
  expect(sessionStore.get('default')).toBeDefined();
  expect(leaseRegistry.listActiveLeases()).toHaveLength(1);
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
});

test('router serializes same-device open requests before first session creation finishes', async () => {
  const sessionStore = makeSessionStore('agent-device-router-open-');
  const sameDevice = makeIosDevice('SIM-001');
  const resolutionPlan: Array<DeviceInfo | AppError> = [
    new AppError('DEVICE_NOT_FOUND', 'device discovery is still warming up'),
    sameDevice,
    new AppError('DEVICE_NOT_FOUND', 'device discovery is still warming up'),
    sameDevice,
  ];
  let resolutionCalls = 0;
  let markSecondPreflightFinished: (() => void) | undefined;
  const secondPreflightFinished = new Promise<void>((resolve) => {
    markSecondPreflightFinished = resolve;
  });
  mockResolveTargetDevice.mockImplementation(async () => {
    resolutionCalls += 1;
    const next = resolutionPlan.shift();
    if (!next) {
      throw new Error('Unexpected resolveTargetDevice call');
    }
    if (resolutionCalls === 3) markSecondPreflightFinished?.();
    if (next instanceof AppError) {
      throw next;
    }
    return next;
  });

  let ensureCalls = 0;
  let activeEnsures = 0;
  let maxActiveEnsures = 0;
  let releaseFirstEnsure: (() => void) | undefined;
  let markFirstEnsureStarted: (() => void) | undefined;
  const firstEnsureStarted = new Promise<void>((resolve) => {
    markFirstEnsureStarted = resolve;
  });
  mockAwaitFixtureReadiness.mockImplementation(async () => {
    ensureCalls += 1;
    activeEnsures += 1;
    maxActiveEnsures = Math.max(maxActiveEnsures, activeEnsures);
    if (ensureCalls === 1) {
      markFirstEnsureStarted?.();
      await new Promise<void>((resolve) => {
        releaseFirstEnsure = () => {
          activeEnsures -= 1;
          resolve();
        };
      });
      return;
    }
    activeEnsures -= 1;
  });

  const handler = createOpenHandler(sessionStore);

  const firstOpen = handler(openRequest('session-a', { platform: 'ios' }, 'req-open-1'));

  await firstEnsureStarted;

  const secondOpen = handler(
    openRequest('session-b', { platform: 'ios', udid: 'SIM-001' }, 'req-open-2'),
  );

  await secondPreflightFinished;
  expect(ensureCalls).toBe(1);
  expect(maxActiveEnsures).toBe(1);

  releaseFirstEnsure?.();

  const [firstResponse, secondResponse] = await Promise.all([firstOpen, secondOpen]);

  expect(firstResponse.ok).toBe(true);
  expect(secondResponse.ok).toBe(false);
  if (!secondResponse.ok) {
    expect(secondResponse.error.code).toBe('DEVICE_IN_USE');
  }
  expect(maxActiveEnsures).toBe(1);
});

test('router allows pre-open requests for different devices to proceed concurrently', async () => {
  const sessionStore = makeSessionStore('agent-device-router-open-');
  const deviceA = makeIosDevice('SIM-001');
  const deviceB = makeIosDevice('SIM-002');
  mockResolveTargetDevice.mockImplementation(async (flags) => {
    if (flags.udid === 'SIM-001') {
      return deviceA;
    }
    if (flags.udid === 'SIM-002') {
      return deviceB;
    }
    throw new Error(`Unexpected UDID ${String(flags.udid)}`);
  });

  let ensureCalls = 0;
  let activeEnsures = 0;
  let maxActiveEnsures = 0;
  const releases: Array<() => void> = [];
  let markBothEnsuresStarted: (() => void) | undefined;
  const bothEnsuresStarted = new Promise<void>((resolve) => {
    markBothEnsuresStarted = resolve;
  });
  mockAwaitFixtureReadiness.mockImplementation(async () => {
    ensureCalls += 1;
    activeEnsures += 1;
    maxActiveEnsures = Math.max(maxActiveEnsures, activeEnsures);
    if (ensureCalls === 2) markBothEnsuresStarted?.();
    await new Promise<void>((resolve) => {
      releases.push(() => {
        activeEnsures -= 1;
        resolve();
      });
    });
  });

  const handler = createOpenHandler(sessionStore);

  const firstOpen = handler(
    openRequest('session-a', { platform: 'ios', udid: 'SIM-001' }, 'req-open-a'),
  );
  const secondOpen = handler(
    openRequest('session-b', { platform: 'ios', udid: 'SIM-002' }, 'req-open-b'),
  );

  await bothEnsuresStarted;

  expect(ensureCalls).toBe(2);
  expect(maxActiveEnsures).toBe(2);
  releases.splice(0).forEach((release) => release());

  const [firstResponse, secondResponse] = await Promise.all([firstOpen, secondOpen]);

  expect(firstResponse.ok).toBe(true);
  expect(secondResponse.ok).toBe(true);
  expect(maxActiveEnsures).toBe(2);
});

// Preparation can boot the device an open is returning to, and the claim has to cover that boot:
// otherwise the boot an owner caused for itself is what takes the device away from it. The device
// boots strictly between the two renewals of one reopen, so only the post-preparation renewal can
// raise the stamp above the boot, and the foreign open asks from its own store, which is where
// reboot-based claim settlement happens.
test('an open that booted the device keeps the device against a foreign open', async () => {
  const sessionStore = makeSessionStore('agent-device-router-open-boot-');
  const foreignStore = makeSessionStore('agent-device-router-open-boot-foreign-');
  const device = makeIosDevice('SIM-COLD-BOOTED');
  mockResolveTargetDevice.mockResolvedValue(device);
  const claimsDir = mkdtempForTestSync('agent-device-router-open-boot-claims-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;

  // The fixture's platform tools answer device state through this seam, so a test that wants a boot
  // during preparation arms it here and the fake device reports that boot to every later probe.
  let bootedAtMs: number | undefined;
  let bootArmed = false;
  mockObserveBoot.mockImplementation(async () =>
    bootedAtMs === undefined
      ? ({ observed: false, reason: 'unobserved' } as const)
      : ({ observed: true, bootedAtMs } as const),
  );
  mockAwaitFixtureReadiness.mockImplementation(async () => {
    if (bootArmed) {
      bootArmed = false;
      bootedAtMs = Date.now();
    }
  });

  try {
    const opened = await createOpenHandler(sessionStore)(
      openRequest('boot-owner', { platform: 'ios' }, 'req-open-boot-owner', {}, ['FixtureApp']),
    );
    expect(opened.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2));

    bootArmed = true;
    const reopened = await createOpenHandler(sessionStore)(
      openRequest('boot-owner', { platform: 'ios' }, 'req-open-boot-reopen', {}, ['FixtureApp']),
    );
    expect(reopened.ok).toBe(true);
    expect(bootedAtMs).toBeTypeOf('number');
    expect(storedClaimUpdatedAt(device)).toBeGreaterThanOrEqual(bootedAtMs ?? 0);

    const foreign = await createOpenHandler(foreignStore)(
      openRequest('boot-foreign', { platform: 'ios' }, 'req-open-boot-foreign', {}, ['FixtureApp']),
    );

    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe('DEVICE_IN_USE');
    expect(inspectDeviceClaims({ udid: device.id })[0]?.claim?.session).toBe('boot-owner');
  } finally {
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

const LEASED_MACOS_BUNDLE = 'com.example.leased';
const LEASED_MACOS_HOST: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'leased-host-mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

function leasedMacOsMeta(leaseId: string, requestId: string) {
  return {
    requestId,
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseId,
    sessionIsolation: 'tenant',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    deviceKey: LEASED_MACOS_BUNDLE,
    leaseBackend: 'macos-app',
  };
}

test('open under a macos-app lease names no host path or device, and an unleased open still does', async () => {
  mockResolveTargetDevice.mockResolvedValue(LEASED_MACOS_HOST);
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.putHostLease('a1b2c3d4e5f60718293a4b5c6d7e8f90', {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    leaseBackend: 'macos-app',
    deviceKey: LEASED_MACOS_BUNDLE,
  });
  const sessionStore = makeSessionStore('agent-device-router-open-macos-lease-');

  vi.stubEnv('AGENT_DEVICE_MACOS_APP_BACKEND', 'native');
  const opened = await createOpenHandler(
    sessionStore,
    leaseRegistry,
  )(
    openRequest(
      'default',
      { platform: 'macos' },
      'req-open-macos-lease',
      leasedMacOsMeta(lease.leaseId, 'req-open-macos-lease'),
      [LEASED_MACOS_BUNDLE],
    ),
  );
  vi.unstubAllEnvs();

  expect(opened).toMatchObject({
    ok: true,
    data: { appBundleId: LEASED_MACOS_BUNDLE, platform: 'macos', target: 'desktop' },
  });
  const wire = JSON.stringify(opened);
  for (const hostFact of [
    sessionStore.resolveDaemonStateDir(),
    LEASED_MACOS_HOST.name,
    LEASED_MACOS_HOST.id,
  ]) {
    expect(wire).not.toContain(hostFact);
  }

  const unleased = await createOpenHandler(makeSessionStore('agent-device-router-open-macos-'))(
    openRequest('plain', { platform: 'macos' }, 'req-open-macos-plain', {}, [LEASED_MACOS_BUNDLE]),
  );
  expect(unleased).toMatchObject({
    ok: true,
    data: { device: LEASED_MACOS_HOST.name, id: LEASED_MACOS_HOST.id },
  });
  expect(unleased.ok && unleased.data?.sessionStateDir).toEqual(expect.any(String));
});
