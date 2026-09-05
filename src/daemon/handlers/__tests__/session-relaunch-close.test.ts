import { test, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { LeaseRegistry } from '../../lease-registry.ts';
import { setActiveProviderDeviceRuntimes } from '../../../provider-device-runtime.ts';
import { createTestDeviceInventoryGateways } from '../../../__tests__/test-utils/device-inventory-gateways.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { makeSession } from '../../../__tests__/test-utils/session-factories.ts';
import { getResolveTargetDeviceMock } from '../../__tests__/request-router-dispatch-mocks.ts';
import type { DaemonRequest } from '../../types.ts';

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: vi.fn(async () => undefined) };
});
vi.mock('../../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return {
    ...actual,
    prepareIosRunner: vi.fn(async () => ({
      runner: { currentUptimeMs: 42 },
      connectMs: 3,
      healthCheckMs: 3,
    })),
    prewarmAppleRunnerCache: vi.fn(),
    prewarmIosRunnerSession: vi.fn(),
    notifyIosRunnerAppRelaunched: vi.fn(async () => {}),
    // A retained Simulator runner survives the relaunch, so its cached target is reset.
    hasLiveIosRunnerSession: vi.fn(() => true),
    scheduleIosRunnerIdleStop: vi.fn(),
    stopIosRunnerSession: vi.fn(async () => {}),
  };
});
vi.mock('@agent-device/platform-apple/macos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-apple/macos')>();
  return { ...actual, runMacOsAlertAction: vi.fn(async () => {}) };
});
vi.mock('@agent-device/platform-apple/app-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-resolution')>();
  return {
    ...actual,
    resolveIosApp: vi.fn(async (_device, app: string) => app),
    resolveIosSimulatorDeepLinkBundleId: vi.fn(async () => undefined),
  };
});
vi.mock('../../../platform-runtime-open-target.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform-runtime-open-target.ts')>();
  return { ...actual, resolveAndroidPackageForOpen: vi.fn(async () => undefined) };
});

import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/test-device-runtime-gateway.ts';
import {
  dispatchApplicationLifecycleEffect,
  awaitFixtureReadiness,
  discoverReadyAndroidEmulators,
} from '../../__tests__/application-lifecycle-runtime-fixture.ts';
import { ensureDeviceReady } from '../../device-ready.ts';
import {
  prewarmIosRunnerSession,
  notifyIosRunnerAppRelaunched,
  stopIosRunnerSession,
  scheduleIosRunnerIdleStop,
} from '@agent-device/platform-apple/runner/operations';
import { runMacOsAlertAction } from '@agent-device/platform-apple/macos';
import { refFrameState } from '../../ref-frame.ts';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);
const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const mockAwaitFixtureReadiness = vi.mocked(awaitFixtureReadiness);
const mockDiscoverReadyAndroidEmulators = vi.mocked(discoverReadyAndroidEmulators);
const mockPrewarmIosRunnerSession = vi.mocked(prewarmIosRunnerSession);
const mockNotifyIosRunnerAppRelaunched = vi.mocked(notifyIosRunnerAppRelaunched);
const mockStopIosRunner = vi.mocked(stopIosRunnerSession);
const mockScheduleIosRunnerIdleStop = vi.mocked(scheduleIosRunnerIdleStop);
const mockDismissMacOsAlert = vi.mocked(runMacOsAlertAction);

beforeEach(() => {
  vi.useRealTimers();
  mockResolveTargetDevice.mockReset();
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue(undefined);
  mockAwaitFixtureReadiness.mockReset();
  mockAwaitFixtureReadiness.mockResolvedValue(undefined);
  mockDiscoverReadyAndroidEmulators.mockReset();
  mockDiscoverReadyAndroidEmulators.mockImplementation(async (device) => [
    {
      ...device,
      id: device.id.startsWith('emulator-') ? device.id : `emulator-${device.id}`,
      booted: true,
    },
  ]);
  mockPrewarmIosRunnerSession.mockReset();
  mockNotifyIosRunnerAppRelaunched.mockReset();
  mockNotifyIosRunnerAppRelaunched.mockResolvedValue(undefined);
  mockStopIosRunner.mockReset();
  mockStopIosRunner.mockResolvedValue(undefined);
  mockScheduleIosRunnerIdleStop.mockReset();
  mockDismissMacOsAlert.mockReset();
  mockDismissMacOsAlert.mockResolvedValue({} as any);
});

function createHandler(
  sessionStore: ReturnType<typeof makeSessionStore>,
  leaseRegistry: LeaseRegistry = new LeaseRegistry(),
) {
  return createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

let requestSeq = 0;

function sessionRequest(
  session: string,
  command: 'open' | 'close',
  options: {
    positionals?: string[];
    flags?: Record<string, unknown>;
    internal?: DaemonRequest['internal'];
  } = {},
): DaemonRequest {
  requestSeq += 1;
  return {
    token: 'test-token',
    session,
    command,
    positionals: options.positionals ?? [],
    flags: options.flags ?? {},
    internal: options.internal,
    meta: { requestId: `req-${command}-${requestSeq}` },
  };
}

test('open --relaunch closes and reopens active session app', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'android-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'android',
        id: 'emulator-5554',
        name: 'Pixel Emulator',
        kind: 'emulator',
        booted: true,
      },
      appName: 'com.example.app',
    }),
  );

  const calls: Array<{ command: string; positionals: string[] }> = [];
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push({ command, positionals: positionals ?? [] });
    return {};
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { flags: { relaunch: true } }),
  );

  expect(response.ok).toBe(true);
  expect(calls).toEqual([
    { command: 'close', positionals: ['com.example.app'] },
    { command: 'open', positionals: ['com.example.app'] },
  ]);
});

test('open --relaunch leaves the old frame expired when the close dispatch fails after dispatch (ADR 0014)', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'android-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'android',
        id: 'emulator-5554',
        name: 'Pixel Emulator',
        kind: 'emulator',
        booted: true,
      },
      appName: 'com.example.app',
      snapshotGeneration: 400,
    }),
  );
  // A freshly issued frame is active before the relaunch.
  expect(refFrameState(sessionStore.get(sessionName)!)).toBe('active');

  // The relaunch close dispatches and then fails/times out AFTER the app may
  // already have been torn down.
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'close') throw new Error('adb: close timed out after dispatch');
    return {};
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { flags: { relaunch: true } }),
  ).catch(() => null);

  // Whether the failure surfaced as an error response or a throw, the existing
  // session's frame was expired BEFORE the close dispatch and stays expired — a
  // post-dispatch close failure never restores it (there is no rollback).
  expect(response?.ok ?? false).toBe(false);
  expect(refFrameState(sessionStore.get(sessionName)!)).toBe('expired');
});

test('open --relaunch does not let an ambient provider claim suppress a local pre-close', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'provider-android-session';
  const device = {
    platform: 'android' as const,
    id: 'provider-android-1',
    name: 'Provider Android',
    kind: 'emulator' as const,
    booted: true,
  };
  setActiveProviderDeviceRuntimes([
    {
      provider: 'fake-provider',
      leaseLifecycle: {},
      deviceInventoryProvider: async () => [device],
      ownsDevice: (candidate) => candidate.id === device.id,
      getInteractor: () => undefined,
      shutdown: async () => {},
    },
  ]);
  mockResolveTargetDevice.mockResolvedValue(device);

  const calls: Array<{ command: string; positionals: string[] }> = [];
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push({ command, positionals: positionals ?? [] });
    return {};
  });

  try {
    const response = await createHandler(sessionStore)(
      sessionRequest(sessionName, 'open', {
        positionals: ['com.example.app'],
        flags: { relaunch: true, platform: 'android' },
      }),
    );

    expect(response.ok).toBe(true);
    expect(calls).toEqual([
      { command: 'close', positionals: ['com.example.app'] },
      { command: 'open', positionals: ['com.example.app'] },
    ]);
  } finally {
    setActiveProviderDeviceRuntimes([]);
  }
});

test('open --relaunch on physical iOS retains runner through close/open', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-session';
  const device = {
    platform: 'apple' as const,
    appleOs: 'ios' as const,
    id: 'ios-device-1',
    name: 'My iPhone',
    kind: 'device' as const,
    booted: true,
  };
  sessionStore.set(sessionName, makeSession(sessionName, { device, appName: 'com.example.app' }));

  const calls: string[] = [];
  mockResolveTargetDevice.mockResolvedValue(device);
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockNotifyIosRunnerAppRelaunched.mockImplementation(async () => {
    calls.push('reset-runner-target');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${(positionals ?? []).join(' ')}`);
    return {};
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { flags: { relaunch: true } }),
  );

  expect(response.ok).toBe(true);
  expect(calls).toEqual(['close:com.example.app', 'open:com.example.app', 'reset-runner-target']);
  expect(mockStopIosRunner).not.toHaveBeenCalled();
});

test('open --relaunch on iOS simulator collapses into one terminate-running open dispatch', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-simulator-session';
  const device = {
    platform: 'apple' as const,
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator' as const,
    booted: true,
  };
  sessionStore.set(sessionName, makeSession(sessionName, { device, appName: 'com.example.app' }));

  const calls: string[] = [];
  mockResolveTargetDevice.mockResolvedValue(device);
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  let openContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
    calls.push(`${command}:${(positionals ?? []).join(' ')}`);
    if (command === 'open') openContext = context as Record<string, unknown>;
    return {};
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { flags: { relaunch: true } }),
  );

  expect(response.ok).toBe(true);
  expect(calls).toEqual(['open:com.example.app']);
  expect(openContext?.terminateRunningApp).toBe(true);
  expect(mockNotifyIosRunnerAppRelaunched).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'sim-1' }),
    expect.any(Object),
  );
});

test('open <app> <url> --relaunch on iOS simulator delegates termination to the URL open', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-simulator-url-relaunch-session';
  const device = {
    platform: 'apple' as const,
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator' as const,
    booted: true,
  };
  sessionStore.set(sessionName, makeSession(sessionName, { device, appName: 'com.example.app' }));

  const calls: string[] = [];
  mockResolveTargetDevice.mockResolvedValue(device);
  let openContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
    calls.push(`${command}:${(positionals ?? []).join(' ')}`);
    if (command === 'open') openContext = context as Record<string, unknown>;
    return {};
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', {
      positionals: ['com.example.app', 'https://example.com/deal'],
      flags: { relaunch: true },
    }),
  );

  expect(response.ok).toBe(true);
  expect(calls).toEqual(['open:com.example.app https://example.com/deal']);
  expect(openContext?.terminateRunningApp).toBe(true);
});

test('open --relaunch --clear-app-state on iOS simulator keeps close-first ordering', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-simulator-clear-state-session';
  const device = {
    platform: 'apple' as const,
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator' as const,
    booted: true,
  };
  sessionStore.set(sessionName, makeSession(sessionName, { device, appName: 'com.example.app' }));

  const calls: string[] = [];
  mockResolveTargetDevice.mockResolvedValue(device);
  let openContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
    calls.push(`${command}:${(positionals ?? []).join(' ')}`);
    if (command === 'open') openContext = context as Record<string, unknown>;
    return {};
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { flags: { relaunch: true, clearAppState: true } }),
  );

  expect(response.ok).toBe(true);
  expect(calls).toEqual(['close:com.example.app', 'open:com.example.app']);
  expect(openContext?.terminateRunningApp).toBeUndefined();
});

test('open --relaunch includes timing and waits for iOS runner prewarm after opening app', async () => {
  vi.useFakeTimers({ now: 1_000 });
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-timing-session';
  const events: string[] = [];
  const device = {
    platform: 'apple' as const,
    appleOs: 'ios' as const,
    id: 'ios-device-1',
    name: 'My iPhone',
    kind: 'device' as const,
    booted: true,
  };
  sessionStore.set(
    sessionName,
    makeSession(sessionName, { device, appName: 'Example', appBundleId: 'com.example.app' }),
  );

  mockPrewarmIosRunnerSession.mockImplementation(
    () =>
      new Promise((resolve) => {
        events.push('prewarm-start');
        setTimeout(() => {
          events.push('prewarm-finish');
          resolve();
        }, 250);
      }),
  );
  mockStopIosRunner.mockImplementation(async () => {
    events.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command) => {
    events.push(`dispatch:${command}`);
    return {};
  });

  const responsePromise = createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { flags: { relaunch: true } }),
  );

  await vi.advanceTimersByTimeAsync(250);
  const response = await responsePromise;

  expect(response.ok).toBe(true);
  expect(events).toEqual(['dispatch:close', 'dispatch:open', 'prewarm-start', 'prewarm-finish']);
  expect(mockStopIosRunner).not.toHaveBeenCalled();
  expect((response as any).data?.timing).toMatchObject({
    runnerPrewarmKind: 'session',
    runnerPrewarmScheduled: true,
    runnerPrewarmWaited: true,
    runnerPrewarmDurationMs: 250,
  });
  expect((response as any).data?.timing?.totalDurationMs).toBeGreaterThanOrEqual(250);
});

test('open --relaunch on iOS without existing session closes then opens target app', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-new-session';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    appleOs: 'ios',
    id: 'ios-device-1',
    name: 'My iPhone',
    kind: 'device',
    booted: true,
  });

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockNotifyIosRunnerAppRelaunched.mockImplementation(async () => {
    calls.push('reset-runner-target');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${(positionals ?? []).join(' ')}`);
    return {};
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', {
      positionals: ['com.example.app'],
      flags: { relaunch: true, platform: 'ios' },
    }),
  );

  expect(response.ok).toBe(true);
  expect(calls).toEqual(['close:com.example.app', 'open:com.example.app', 'reset-runner-target']);
  expect(mockStopIosRunner).not.toHaveBeenCalled();
});

test('close on macOS session stops runner and dismisses automation alert before delete', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'macos-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        appleOs: 'macos',
        id: 'host-macos-local',
        name: 'Host Mac',
        kind: 'device',
        target: 'desktop',
        booted: true,
      },
      appBundleId: 'com.apple.systempreferences',
      appName: 'System Settings',
    }),
  );

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async (deviceId) => {
    calls.push(`stop-runner:${deviceId}`);
  });
  mockDismissMacOsAlert.mockImplementation(async (action, options) => {
    calls.push(
      `dismiss-alert:${action}:${(options as any)?.bundleId ?? (options as any)?.surface ?? 'frontmost'}`,
    );
    return {};
  });

  const response = await createHandler(sessionStore)(sessionRequest(sessionName, 'close'));

  expect(response.ok).toBe(true);
  expect(calls).toEqual([
    'stop-runner:host-macos-local',
    'dismiss-alert:dismiss:com.apple.systempreferences',
  ]);
  expect(sessionStore.get(sessionName)).toBe(undefined);
});

test('close on iOS simulator session retains runner and deletes the session', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-simulator-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 17 Pro',
        kind: 'simulator',
        booted: true,
      },
      appName: 'com.example.app',
    }),
  );

  const response = await createHandler(sessionStore)(sessionRequest(sessionName, 'close'));

  expect(response.ok).toBe(true);
  expect(mockStopIosRunner).not.toHaveBeenCalled();
  expect(mockScheduleIosRunnerIdleStop).toHaveBeenCalledWith('sim-1');
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close on iOS simulator with scoped simulator set stops runner before deleting session', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-scoped-simulator-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 17 Pro',
        kind: 'simulator',
        booted: true,
        simulatorSetPath: '/tmp/tenant-a/simulator-set',
      },
      appName: 'com.example.app',
    }),
  );

  const response = await createHandler(sessionStore)(sessionRequest(sessionName, 'close'));

  expect(response.ok).toBe(true);
  expect(mockStopIosRunner).toHaveBeenCalledWith('sim-1');
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close on leased iOS simulator session stops runner before deleting session', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-leased-simulator-session';
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-simulator',
    deviceKey: 'ios:sim-1',
    clientId: 'client-a',
  });
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 17 Pro',
        kind: 'simulator',
        booted: true,
      },
      appName: 'com.example.app',
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
        deviceKey: lease.deviceKey,
        clientId: lease.clientId,
        expiresAt: lease.expiresAt,
      },
    }),
  );

  const response = await createHandler(
    sessionStore,
    leaseRegistry,
  )(sessionRequest(sessionName, 'close'));

  expect(response.ok).toBe(true);
  expect(mockStopIosRunner).toHaveBeenCalledWith('sim-1');
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close --shutdown on iOS simulator stops runner before deleting session', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-simulator-shutdown-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 17 Pro',
        kind: 'simulator',
        booted: true,
      },
      appName: 'com.example.app',
    }),
  );

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'close', { flags: { shutdown: true } }),
  );

  expect(response.ok).toBe(true);
  expect(mockStopIosRunner).toHaveBeenCalledWith('sim-1');
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close <app> on iOS stops runner before app close dispatch and performs final idempotent stop', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-close-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'ios-device-1',
        name: 'My iPhone',
        kind: 'device',
        booted: true,
      },
      appName: 'com.example.app',
    }),
  );

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${(positionals ?? []).join(' ')}`);
    return {};
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'close', { positionals: ['com.example.app'] }),
  );

  expect(response.ok).toBe(true);
  expect(calls).toEqual(['stop-runner', 'close:com.example.app', 'stop-runner']);
});

test('close <app> on iOS simulator retains runner while terminating app', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-simulator-close-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 17 Pro',
        kind: 'simulator',
        booted: true,
      },
      appName: 'com.example.app',
    }),
  );

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${(positionals ?? []).join(' ')}`);
    return {};
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'close', { positionals: ['com.example.app'] }),
  );

  expect(response.ok).toBe(true);
  expect(calls).toEqual(['close:com.example.app']);
});

test('app-only close terminates an iOS simulator app without ending its session', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'ios-simulator-app-only-close';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 17 Pro',
        kind: 'simulator',
        booted: true,
      },
      appBundleId: 'com.example.app',
      appName: 'Example App',
    }),
  );

  mockDispatch.mockImplementation(async () => ({}));

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'close', {
      positionals: ['com.example.app'],
      internal: { closeAppOnly: true },
    }),
  );

  expect(response.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'sim-1' }),
    'close',
    ['com.example.app'],
    undefined,
    expect.any(Object),
  );
  expect(mockStopIosRunner).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)).toBeDefined();
});

test('close <app> on macOS stops runner before app close dispatch and dismisses automation alert', async () => {
  const sessionStore = makeSessionStore('agent-device-relaunch-close-');
  const sessionName = 'macos-close-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        appleOs: 'macos',
        id: 'host-macos-local',
        name: 'Host Mac',
        kind: 'device',
        target: 'desktop',
        booted: true,
      },
      appBundleId: 'com.apple.systempreferences',
      appName: 'System Settings',
    }),
  );

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async (deviceId) => {
    calls.push(`stop-runner:${deviceId}`);
  });
  mockDismissMacOsAlert.mockImplementation(async (action, options) => {
    calls.push(
      `dismiss-alert:${action}:${(options as any)?.bundleId ?? (options as any)?.surface ?? 'frontmost'}`,
    );
    return {};
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${(positionals ?? []).join(' ')}`);
    return {};
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'close', { positionals: ['System Settings'] }),
  );

  expect(response.ok).toBe(true);
  expect(calls).toEqual([
    'stop-runner:host-macos-local',
    'close:System Settings',
    'stop-runner:host-macos-local',
    'dismiss-alert:dismiss:com.apple.systempreferences',
  ]);
});
