import { test, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: vi.fn(async () => undefined) };
});
vi.mock('../../../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
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
vi.mock('../../../../platform-runtime-open-target.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../platform-runtime-open-target.ts')>();
  return { ...actual, resolveAndroidPackageForOpen: vi.fn(async () => undefined) };
});

import {
  createLifecycleDeviceRuntimeGatewaySpies,
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../../__tests__/test-device-runtime-gateway.ts';
import { dispatchApplicationLifecycleEffect } from '../../../__tests__/application-lifecycle-runtime-fixture.ts';
import { getResolveTargetDeviceMock } from '../../../__tests__/request-router-dispatch-mocks.ts';
import { createTestDeviceInventoryGateways } from '../../../../__tests__/test-utils/device-inventory-gateways.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { makeSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { LeaseRegistry } from '../../../lease-registry.ts';
import type { DaemonRequest } from '../../../types.ts';
import {
  prepareIosRunner,
  prewarmAppleRunnerCache,
  prewarmIosRunnerSession,
  notifyIosRunnerAppRelaunched,
} from '@agent-device/platform-apple/runner/operations';
import {
  resolveIosApp,
  resolveIosSimulatorDeepLinkBundleId,
} from '@agent-device/platform-apple/app-resolution';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const mockPrepareIosRunner = vi.mocked(prepareIosRunner);
const mockPrewarmAppleRunnerCache = vi.mocked(prewarmAppleRunnerCache);
const mockPrewarmIosRunnerSession = vi.mocked(prewarmIosRunnerSession);
const mockNotifyIosRunnerAppRelaunched = vi.mocked(notifyIosRunnerAppRelaunched);
const mockResolveIosApp = vi.mocked(resolveIosApp);
const mockResolveIosSimulatorDeepLinkBundleId = vi.mocked(resolveIosSimulatorDeepLinkBundleId);

beforeEach(() => {
  vi.useRealTimers();
  mockResolveTargetDevice.mockReset();
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue(undefined);
  mockPrepareIosRunner.mockReset();
  mockPrepareIosRunner.mockResolvedValue({
    runner: { currentUptimeMs: 42 },
    connectMs: 3,
    healthCheckMs: 3,
  });
  mockPrewarmAppleRunnerCache.mockReset();
  mockPrewarmIosRunnerSession.mockReset();
  mockNotifyIosRunnerAppRelaunched.mockReset();
  mockNotifyIosRunnerAppRelaunched.mockResolvedValue(undefined);
  mockResolveIosApp.mockReset();
  mockResolveIosApp.mockImplementation(async (_device, app: string) =>
    app.includes('.') ? app : `com.example.${app.toLowerCase()}`,
  );
  mockResolveIosSimulatorDeepLinkBundleId.mockReset();
  mockResolveIosSimulatorDeepLinkBundleId.mockResolvedValue(undefined);
});

function createHandler(
  sessionStore: ReturnType<typeof makeSessionStore>,
  deviceRuntimeGateway = lifecycleDeviceRuntimeGateway,
) {
  return createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

let requestSeq = 0;

function sessionRequest(
  session: string,
  command: 'open' | 'prepare',
  options: {
    positionals?: string[];
    flags?: Record<string, unknown>;
    meta?: DaemonRequest['meta'];
  } = {},
): DaemonRequest {
  requestSeq += 1;
  return {
    token: 'test-token',
    session,
    command,
    positionals: options.positionals ?? [],
    flags: options.flags ?? {},
    meta: { requestId: `req-${command}-${requestSeq}`, ...options.meta },
  };
}

test('open URL on existing iOS session clears stale app bundle id', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'ios-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 15',
        kind: 'simulator',
        booted: true,
      },
      appBundleId: 'com.example.old',
      appName: 'Old App',
    }),
  );

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 15',
    kind: 'simulator',
    booted: true,
  });
  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return undefined;
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { positionals: ['https://example.com/path'] }),
  );

  expect(response.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe(undefined);
  expect(updated?.appName).toBe('https://example.com/path');
  expect(dispatchedContext?.appBundleId).toBe(undefined);
});

test('open URL on existing macOS session clears stale app bundle id', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'macos-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        appleOs: 'macos',
        id: 'host-mac',
        name: 'Mac',
        kind: 'device',
        target: 'desktop',
        booted: true,
      },
      appBundleId: 'com.example.old',
      appName: 'Old App',
    }),
  );

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return undefined;
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { positionals: ['https://example.com/path'] }),
  );

  expect(response.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe(undefined);
  expect(updated?.appName).toBe('https://example.com/path');
  expect(dispatchedContext?.appBundleId).toBe(undefined);
});

test('open URL on existing iOS device session preserves app bundle id context', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'ios-device-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'ios-device-1',
        name: 'iPhone Device',
        kind: 'device',
        booted: true,
      },
      appBundleId: 'com.example.app',
      appName: 'Example App',
    }),
  );

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return undefined;
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { positionals: ['myapp://item/42'] }),
  );

  expect(response.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.example.app');
  expect(updated?.appName).toBe('myapp://item/42');
  expect(dispatchedContext?.appBundleId).toBe('com.example.app');
});

test('open custom URL on existing iOS simulator session preserves app bundle id context', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
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
      appBundleId: 'com.example.app',
      appName: 'Example App',
    }),
  );
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return undefined;
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { positionals: ['myapp://item/42'] }),
  );

  expect(response.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.example.app');
  expect(updated?.appName).toBe('myapp://item/42');
  expect(dispatchedContext?.appBundleId).toBe('com.example.app');
});

test('open custom URL on fresh iOS simulator session infers app bundle id from URL scheme', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'ios-simulator-url-session';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });
  mockResolveIosSimulatorDeepLinkBundleId.mockResolvedValue('org.reactnavigation.playground');

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return undefined;
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', {
      positionals: ['rne://navigator-layout'],
      flags: { platform: 'ios', udid: 'sim-1' },
    }),
  );

  expect(response.ok).toBe(true);
  expect(mockResolveIosSimulatorDeepLinkBundleId).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'sim-1', kind: 'simulator' }),
    'rne://navigator-layout',
  );
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('org.reactnavigation.playground');
  expect(updated?.appName).toBe('rne://navigator-layout');
  expect(dispatchedContext?.appBundleId).toBe('org.reactnavigation.playground');
  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledTimes(1);
});

test('open iOS simulator app prewarms runner cache during cold boot', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'ios-simulator-cold-boot-cache-prewarm';
  const device = {
    platform: 'apple' as const,
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator' as const,
    booted: false,
  };
  mockResolveTargetDevice.mockResolvedValue(device);
  mockResolveIosApp.mockResolvedValueOnce('com.example.app');

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', {
      positionals: ['Demo'],
      flags: { platform: 'ios', udid: 'sim-1' },
      meta: { requestId: 'open-request' },
    }),
  );

  expect(response.ok).toBe(true);
  await vi.waitFor(() => {
    expect(mockPrewarmAppleRunnerCache).toHaveBeenCalledWith(
      device,
      expect.objectContaining({
        logPath: expect.stringMatching(/runner\.log$/),
        requestId: 'open-request',
      }),
    );
    expect(mockPrewarmIosRunnerSession).toHaveBeenCalledTimes(1);
  });
});

test('open iOS app session prewarms runner session when app bundle id is known', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'ios-device-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'ios-device-1',
        name: 'iPhone Device',
        kind: 'device',
        booted: true,
      },
      appBundleId: 'com.example.previous',
      appName: 'Previous App',
    }),
  );

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { positionals: ['Settings', 'myapp://screen/to'] }),
  );

  expect(response.ok).toBe(true);
  await vi.waitFor(() => {
    expect(mockPrewarmIosRunnerSession).toHaveBeenCalledTimes(1);
    expect(mockPrewarmIosRunnerSession).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'apple', id: 'ios-device-1' }),
      expect.objectContaining({ logPath: expect.stringMatching(/runner\.log$/) }),
    );
  });
});

test('open iOS Maestro app link waits for runner prewarm before launching app', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'ios-maestro-open-link';
  const events: string[] = [];
  let finishPrewarm: (() => void) | undefined;
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'ios-device-1',
        name: 'iPhone Device',
        kind: 'device',
        booted: true,
      },
      appBundleId: 'com.example.previous',
      appName: 'Previous App',
    }),
  );

  mockPrewarmIosRunnerSession.mockImplementation(
    () =>
      new Promise((resolve) => {
        events.push('prewarm-start');
        finishPrewarm = () => {
          events.push('prewarm-finish');
          resolve();
        };
      }),
  );
  mockDispatch.mockImplementation(async (_device, command) => {
    events.push(`dispatch:${command}`);
    return undefined;
  });

  const responsePromise = createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', {
      positionals: ['com.example.app', 'rne://screen-layout'],
      flags: { maestro: { prewarmRunnerBeforeOpen: true } },
    }),
  );

  await vi.waitFor(() => expect(events).toEqual(['prewarm-start']));

  finishPrewarm?.();
  const response = await responsePromise;

  expect(response.ok).toBe(true);
  expect(events).toEqual(['prewarm-start', 'prewarm-finish', 'dispatch:open']);
  expect((response as { data?: Record<string, unknown> }).data?.timing).toMatchObject({
    runnerPrewarmKind: 'session',
    runnerPrewarmScheduled: true,
    runnerPrewarmWaited: true,
  });
});

test('open iOS Maestro app link resets a simulator runner prewarmed before URL dispatch', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'ios-simulator-maestro-open-link';
  const events: string[] = [];
  const device = {
    platform: 'apple' as const,
    id: 'ios-simulator-1',
    name: 'iPhone Simulator',
    kind: 'simulator' as const,
    booted: true,
  };
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device,
      appBundleId: 'com.example.app',
      appName: 'Example App',
    }),
  );
  mockResolveTargetDevice.mockResolvedValue(device);

  mockPrewarmIosRunnerSession.mockImplementation(async () => {
    events.push('prewarm');
  });
  mockDispatch.mockImplementation(async (_device, command) => {
    events.push(`dispatch:${command}`);
    return undefined;
  });
  mockNotifyIosRunnerAppRelaunched.mockImplementation(async () => {
    events.push('target-reset');
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', {
      positionals: ['com.example.app', 'rne://screen-layout'],
      flags: { maestro: { prewarmRunnerBeforeOpen: true } },
    }),
  );

  expect(response.ok).toBe(true);
  expect(events).toEqual(['prewarm', 'dispatch:open', 'target-reset']);
  expect(mockNotifyIosRunnerAppRelaunched).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'ios-simulator-1' }),
    expect.any(Object),
  );
});

test('open iOS Maestro app link reports blocking runner prewarm failures before launching app', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'ios-maestro-open-link-prewarm-failed';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'ios-device-1',
        name: 'iPhone Device',
        kind: 'device',
        booted: true,
      },
      appBundleId: 'com.example.previous',
      appName: 'Previous App',
    }),
  );
  mockPrewarmIosRunnerSession.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'Developer mode is disabled for Apple development tools', {
      hint: 'Run `sudo DevToolsSecurity -enable`.',
    }),
  );

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', {
      positionals: ['com.example.app', 'rne://screen-layout'],
      flags: { maestro: { prewarmRunnerBeforeOpen: true } },
    }),
  );

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toBe('Developer mode is disabled for Apple development tools');
    expect(response.error.hint).toEqual(expect.stringContaining('DevToolsSecurity -enable'));
  }
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'ios-device-1' }),
    expect.objectContaining({ propagateError: true }),
  );
});

test('open iOS URL without app bundle id skips runner prewarm', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'ios-device-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'ios-device-1',
        name: 'iPhone Device',
        kind: 'device',
        booted: true,
      },
    }),
  );

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'open', { positionals: ['myapp://screen/to'] }),
  );

  expect(response.ok).toBe(true);
  expect(mockPrewarmIosRunnerSession).not.toHaveBeenCalled();
});

test('prepare ios-runner starts the XCTest runner on an explicit iOS selector', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'prepare-ios-runner';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });
  const { gateway, inspectFacts, bind } = createLifecycleDeviceRuntimeGatewaySpies();

  const response = await createHandler(
    sessionStore,
    gateway,
  )(
    sessionRequest(sessionName, 'prepare', {
      positionals: ['ios-runner'],
      flags: { platform: 'ios', udid: 'sim-1', timeoutMs: 240000 },
      meta: { requestId: 'prepare-request' },
    }),
  );

  expect(response.ok).toBe(true);
  expect(inspectFacts).toHaveBeenCalledTimes(1);
  expect(bind).toHaveBeenCalledTimes(1);
  // Readiness runs inside the admitted Apple binding, so `prepare` proves it by reaching the
  // runner at all rather than by observing a retired root readiness call.
  expect(mockPrepareIosRunner).toHaveBeenCalledTimes(1);
  expect(mockPrepareIosRunner).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'sim-1' }),
    expect.objectContaining({
      cleanStaleBundles: true,
      buildTimeoutMs: 240000,
      healthTimeoutMs: 240000,
      logPath: expect.stringMatching(/runner\.log$/),
      prepareDeadline: expect.objectContaining({
        elapsedMs: expect.any(Function),
        isExpired: expect.any(Function),
        remainingMs: expect.any(Function),
      }),
      requestId: 'prepare-request',
      startupTimeoutMs: 240000,
    }),
  );
  if (response.ok) {
    expect(response.data).toMatchObject({
      action: 'ios-runner',
      platform: 'ios',
      deviceId: 'sim-1',
      deviceName: 'iPhone 17 Pro',
      kind: 'simulator',
      connectMs: 3,
      healthCheckMs: 3,
      runner: { currentUptimeMs: 42 },
      message: 'Prepared Apple runner: iPhone 17 Pro',
    });
  }
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('prepare ios-runner explains overlapping timing fields with additive parts', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'prepare-ios-runner-timing';
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000));
  try {
    mockResolveTargetDevice.mockResolvedValue({
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    });
    mockPrepareIosRunner.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(28_337));
      return {
        runner: { currentUptimeMs: 42 },
        buildMs: 10_642,
        connectMs: 12_635,
        healthCheckMs: 14_702,
      };
    });

    const response = await createHandler(sessionStore)(
      sessionRequest(sessionName, 'prepare', {
        positionals: ['ios-runner'],
        flags: { platform: 'ios', udid: 'sim-1' },
      }),
    );

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const data = response.data as Record<string, any>;
    expect(data).toMatchObject({
      buildMs: 10_642,
      connectMs: 12_635,
      healthCheckMs: 14_702,
      timing: {
        totalMs: expect.any(Number),
        additiveParts: {
          buildMs: 10_642,
          connectAfterBuildMs: 1_993,
          healthCheckMs: 14_702,
        },
        containment: {
          connectMs: ['buildMs'],
          healthCheckMs: [],
        },
      },
    });
    expect(data.durationMs).toBe(27_337);
    expect(data.timing.totalMs).toBe(data.durationMs);
    expect(String(data.timing.note)).toMatch(/top-level prepare timing fields.*may overlap/i);
    const additiveParts = data.timing.additiveParts as Record<string, number>;
    const additiveTotalMs = Object.values(additiveParts).reduce((sum, value) => sum + value, 0);
    expect(additiveTotalMs).toBeLessThanOrEqual(data.timing.totalMs);
    expect(data.buildMs + data.connectMs + data.healthCheckMs).toBeGreaterThan(data.durationMs);
  } finally {
    vi.useRealTimers();
  }
});

test('prepare ios-runner starts the XCTest runner on an explicit macOS selector', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  const sessionName = 'prepare-macos-runner';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    appleOs: 'macos',
    id: 'host-macos-local',
    name: 'Host Mac',
    kind: 'device',
    target: 'desktop',
    booted: true,
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'prepare', {
      positionals: ['ios-runner'],
      flags: { platform: 'macos', timeoutMs: 240000 },
      meta: { requestId: 'prepare-macos-request' },
    }),
  );

  expect(response.ok).toBe(true);
  expect(mockPrepareIosRunner).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'host-macos-local' }),
    expect.objectContaining({
      buildTimeoutMs: 240000,
      healthTimeoutMs: 240000,
      prepareDeadline: expect.objectContaining({
        elapsedMs: expect.any(Function),
        isExpired: expect.any(Function),
        remainingMs: expect.any(Function),
      }),
      requestId: 'prepare-macos-request',
    }),
  );
  if (response.ok) {
    expect(response.data).toMatchObject({
      action: 'ios-runner',
      platform: 'macos',
      deviceId: 'host-macos-local',
      deviceName: 'Host Mac',
      kind: 'device',
      message: 'Prepared Apple runner: Host Mac',
    });
  }
});

test('prepare ios-runner rejects non-Apple runner devices', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel 9 Pro XL',
    kind: 'emulator',
    booted: true,
  });
  const { gateway, inspectFacts, bind } = createLifecycleDeviceRuntimeGatewaySpies();

  const response = await createHandler(
    sessionStore,
    gateway,
  )(
    sessionRequest('prepare-android', 'prepare', {
      positionals: ['ios-runner'],
      flags: { platform: 'android', serial: 'emulator-5554' },
    }),
  );

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toBe('prepare is not supported on this device');
  }
  expect(inspectFacts).toHaveBeenCalledTimes(1);
  expect(bind).not.toHaveBeenCalled();
  expect(mockPrepareIosRunner).not.toHaveBeenCalled();
});

test('prepare requires the ios-runner subcommand', async () => {
  const sessionStore = makeSessionStore('agent-device-session-open-url-prewarm-');

  const response = await createHandler(sessionStore)(
    sessionRequest('prepare-invalid', 'prepare', { flags: { platform: 'ios' } }),
  );

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe('prepare requires a subcommand: ios-runner');
  }
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
  expect(mockPrepareIosRunner).not.toHaveBeenCalled();
});
