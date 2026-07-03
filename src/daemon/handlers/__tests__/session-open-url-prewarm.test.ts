import { test, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppError } from '../../../kernel/errors.ts';
import {
  mockDispatch,
  mockResolveTargetDevice,
  mockEnsureDeviceReady,
  mockPrewarmIosRunnerSession,
  mockPrewarmAppleRunnerCache,
  mockPrepareIosRunner,
  mockResolveIosApp,
  mockResolveIosSimulatorDeepLinkBundleId,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from './session-test-harness.ts';
import type { SessionState } from '../../types.ts';
import { handleSessionCommands } from '../session.ts';

test('open URL on existing iOS session clears stale app bundle id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 15',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
  });

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
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['https://example.com/path'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe(undefined);
  expect(updated?.appName).toBe('https://example.com/path');
  expect(dispatchedContext?.appBundleId).toBe(undefined);
});

test('open URL on existing macOS session clears stale app bundle id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-mac',
      name: 'Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['https://example.com/path'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe(undefined);
  expect(updated?.appName).toBe('https://example.com/path');
  expect(dispatchedContext?.appBundleId).toBe(undefined);
});

test('open URL on existing iOS device session preserves app bundle id context', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    appName: 'Example App',
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['myapp://item/42'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.example.app');
  expect(updated?.appName).toBe('myapp://item/42');
  expect(dispatchedContext?.appBundleId).toBe('com.example.app');
});

test('open custom URL on existing iOS simulator session preserves app bundle id context', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    appName: 'Example App',
  });
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
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['myapp://item/42'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockEnsureDeviceReady.mock.calls[0]?.[1]).toEqual({
    deviceHub: false,
    onIosSimulatorColdBootStart: undefined,
  });
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.example.app');
  expect(updated?.appName).toBe('myapp://item/42');
  expect(dispatchedContext?.appBundleId).toBe('com.example.app');
});

test('open custom URL on fresh iOS simulator session infers app bundle id from URL scheme', async () => {
  const sessionStore = makeSessionStore();
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
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['rne://navigator-layout'],
      flags: { platform: 'ios', udid: 'sim-1' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
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
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-cold-boot-cache-prewarm';
  const device: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: false,
  };
  mockResolveTargetDevice.mockResolvedValue(device);
  mockResolveIosApp.mockResolvedValueOnce('com.example.app');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'ios', udid: 'sim-1' },
      meta: { requestId: 'open-request' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  const onColdBootStart = mockEnsureDeviceReady.mock.calls[0]?.[1]?.onIosSimulatorColdBootStart;
  expect(onColdBootStart).toBeTypeOf('function');
  onColdBootStart?.(device);
  expect(mockPrewarmAppleRunnerCache).toHaveBeenCalledWith(
    device,
    expect.objectContaining({
      logPath: expect.stringMatching(/daemon\.log$/),
      requestId: 'open-request',
    }),
  );
  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledTimes(1);
});

test('open iOS app session prewarms runner session when app bundle id is known', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.previous',
    appName: 'Previous App',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Settings', 'myapp://screen/to'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledTimes(1);
  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'ios-device-1' }),
    expect.objectContaining({ logPath: expect.stringMatching(/daemon\.log$/) }),
  );
});

test('open iOS Maestro app link waits for runner prewarm before launching app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-maestro-open-link';
  const events: string[] = [];
  let finishPrewarm: (() => void) | undefined;
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.previous',
    appName: 'Previous App',
  });

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
    return {};
  });

  const responsePromise = handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['com.example.app', 'rne://screen-layout'],
      flags: {
        maestro: { prewarmRunnerBeforeOpen: true },
      },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  await vi.waitFor(() => expect(events).toEqual(['prewarm-start']));

  finishPrewarm?.();
  const response = await responsePromise;

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(events).toEqual(['prewarm-start', 'prewarm-finish', 'dispatch:open']);
  expect((response as any).data?.timing).toMatchObject({
    runnerPrewarmKind: 'session',
    runnerPrewarmScheduled: true,
    runnerPrewarmWaited: true,
  });
});

test('open iOS Maestro app link reports blocking runner prewarm failures before launching app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-maestro-open-link-prewarm-failed';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.previous',
    appName: 'Previous App',
  });
  mockPrewarmIosRunnerSession.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'Developer mode is disabled for Apple development tools', {
      hint: 'Run `sudo DevToolsSecurity -enable`.',
    }),
  );

  await expect(
    handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'open',
        positionals: ['com.example.app', 'rne://screen-layout'],
        flags: {
          maestro: { prewarmRunnerBeforeOpen: true },
        },
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Developer mode is disabled for Apple development tools',
    details: {
      hint: expect.stringContaining('DevToolsSecurity -enable'),
    },
  });
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'ios-device-1' }),
    expect.objectContaining({ propagateError: true }),
  );
});

test('open iOS URL without app bundle id skips runner prewarm', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
  );

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['myapp://screen/to'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockPrewarmIosRunnerSession).not.toHaveBeenCalled();
});

test('prepare ios-runner starts the XCTest runner on an explicit iOS selector', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'prepare-ios-runner';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'prepare',
      positionals: ['ios-runner'],
      flags: { platform: 'ios', udid: 'sim-1', timeoutMs: 240000 },
      meta: { requestId: 'prepare-request' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockEnsureDeviceReady).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'sim-1' }),
  );
  expect(mockPrepareIosRunner).toHaveBeenCalledTimes(1);
  expect(mockPrepareIosRunner).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: 'sim-1' }),
    expect.objectContaining({
      cleanStaleBundles: true,
      buildTimeoutMs: 240000,
      healthTimeoutMs: 240000,
      logPath: expect.stringMatching(/daemon\.log$/),
      prepareDeadline: expect.objectContaining({
        elapsedMs: expect.any(Function),
        isExpired: expect.any(Function),
        remainingMs: expect.any(Function),
      }),
      requestId: 'prepare-request',
      startupTimeoutMs: 240000,
    }),
  );
  expect((response as any).data).toMatchObject({
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
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('prepare ios-runner explains overlapping timing fields with additive parts', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'prepare-ios-runner-timing';
  const dateNow = vi.spyOn(Date, 'now');
  try {
    dateNow.mockReturnValueOnce(1_000).mockReturnValueOnce(28_337);
    mockResolveTargetDevice.mockResolvedValue({
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    });
    mockPrepareIosRunner.mockResolvedValueOnce({
      runner: { currentUptimeMs: 42 },
      buildMs: 10_642,
      connectMs: 12_635,
      healthCheckMs: 14_702,
    });

    const response = await handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'prepare',
        positionals: ['ios-runner'],
        flags: { platform: 'ios', udid: 'sim-1' },
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    });

    expect(response?.ok).toBe(true);
    const data = (response as any).data;
    expect(data).toMatchObject({
      durationMs: 27_337,
      buildMs: 10_642,
      connectMs: 12_635,
      healthCheckMs: 14_702,
      timing: {
        totalMs: 27_337,
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
    expect(String(data.timing.note)).toMatch(/top-level prepare timing fields.*may overlap/i);
    const additiveParts = data.timing.additiveParts as Record<string, number>;
    const additiveTotalMs = Object.values(additiveParts).reduce((sum, value) => sum + value, 0);
    expect(additiveTotalMs).toBeLessThanOrEqual(data.timing.totalMs);
    expect(data.buildMs + data.connectMs + data.healthCheckMs).toBeGreaterThan(data.durationMs);
  } finally {
    dateNow.mockRestore();
  }
});

test('prepare ios-runner starts the XCTest runner on an explicit macOS selector', async () => {
  const sessionStore = makeSessionStore();
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

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'prepare',
      positionals: ['ios-runner'],
      flags: { platform: 'macos', timeoutMs: 240000 },
      meta: { requestId: 'prepare-macos-request' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
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
  expect((response as any).data).toMatchObject({
    action: 'ios-runner',
    platform: 'macos',
    deviceId: 'host-macos-local',
    deviceName: 'Host Mac',
    kind: 'device',
    message: 'Prepared Apple runner: Host Mac',
  });
});

test('prepare ios-runner rejects non-Apple runner devices', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel 9 Pro XL',
    kind: 'emulator',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'prepare-android',
      command: 'prepare',
      positionals: ['ios-runner'],
      flags: { platform: 'android', serial: 'emulator-5554' },
    },
    sessionName: 'prepare-android',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toBe(
      'prepare ios-runner is only supported on Apple runner platforms',
    );
  }
  expect(mockPrepareIosRunner).not.toHaveBeenCalled();
});

test('prepare requires the ios-runner subcommand', async () => {
  const sessionStore = makeSessionStore();

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'prepare-invalid',
      command: 'prepare',
      positionals: [],
      flags: { platform: 'ios' },
    },
    sessionName: 'prepare-invalid',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe('prepare requires a subcommand: ios-runner');
  }
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
  expect(mockPrepareIosRunner).not.toHaveBeenCalled();
});
