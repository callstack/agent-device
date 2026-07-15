import { test, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { LeaseRegistry } from '../../lease-registry.ts';
import {
  mockDispatch,
  mockResolveTargetDevice,
  mockPrewarmIosRunnerSession,
  mockNotifyIosRunnerAppRelaunched,
  mockStopIosRunner,
  mockScheduleIosRunnerIdleStop,
  mockDismissMacOsAlert,
  mockSettleSimulator,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from './session-test-harness.ts';
import { handleSessionCommands } from '../session.ts';

test('open --relaunch closes and reopens active session app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const calls: Array<{ command: string; positionals: string[] }> = [];
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push({ command, positionals });
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls.length).toBe(2);
  expect(calls[0]).toEqual({ command: 'close', positionals: ['com.example.app'] });
  expect(calls[1]).toEqual({ command: 'open', positionals: ['com.example.app'] });
});

test('open --relaunch leaves the old frame expired when the close dispatch fails after dispatch (ADR 0014)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
    appName: 'com.example.app',
    snapshotGeneration: 400,
  });
  // A freshly issued frame is active before the relaunch.
  expect(sessionStore.get(sessionName)?.refFrameState).toBeUndefined();

  // The relaunch close dispatches and then fails/times out AFTER the app may
  // already have been torn down.
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'close') throw new Error('adb: close timed out after dispatch');
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  }).catch(() => null);

  // Whether the failure surfaced as an error response or a throw, the existing
  // session's frame was expired BEFORE the close dispatch and stays expired — a
  // post-dispatch close failure never restores it (there is no rollback).
  expect(response?.ok ?? false).toBe(false);
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');
});

test('open --relaunch on iOS stops runner before close/open', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'My iPhone',
      kind: 'device',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const calls: string[] = [];
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'ios-device-1',
    name: 'My iPhone',
    kind: 'device',
    booted: true,
  });
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual(['stop-runner', 'close:com.example.app', 'open:com.example.app']);
});

test('open --relaunch on iOS simulator collapses into one terminate-running open dispatch', async () => {
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
    appName: 'com.example.app',
  });

  const calls: string[] = [];
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  let openContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    if (command === 'open') openContext = context as Record<string, unknown>;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual(['open:com.example.app']);
  expect(openContext?.terminateRunningApp).toBe(true);
  expect(mockNotifyIosRunnerAppRelaunched).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'sim-1' }),
    expect.any(Object),
  );
});

test('open <app> <url> --relaunch on iOS simulator keeps close-first ordering', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-url-relaunch-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const calls: string[] = [];
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });
  let openContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    if (command === 'open') openContext = context as Record<string, unknown>;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['com.example.app', 'https://example.com/deal'],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  // The URL dispatch path cannot carry the terminate, so the relaunch keeps
  // the explicit close-then-open sequence.
  expect(calls).toEqual(['close:com.example.app', 'open:com.example.app https://example.com/deal']);
  expect(openContext?.terminateRunningApp).toBeUndefined();
});

test('open --relaunch --clear-app-state on iOS simulator keeps close-first ordering', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-clear-state-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const calls: string[] = [];
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });
  let openContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    if (command === 'open') openContext = context as Record<string, unknown>;
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true, clearAppState: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual(['close:com.example.app', 'open:com.example.app']);
  expect(openContext?.terminateRunningApp).toBeUndefined();
});

test('open --relaunch includes timing and waits for iOS runner prewarm after opening app', async () => {
  vi.useFakeTimers({ now: 1_000 });
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-timing-session';
  const events: string[] = [];
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'My iPhone',
      kind: 'device',
      booted: true,
    }),
    appName: 'Example',
    appBundleId: 'com.example.app',
  });

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

  const responsePromise = handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  await vi.advanceTimersByTimeAsync(250);
  const response = await responsePromise;

  expect(response?.ok).toBe(true);
  expect(events).toEqual([
    'stop-runner',
    'dispatch:close',
    'dispatch:open',
    'prewarm-start',
    'prewarm-finish',
  ]);
  expect((response as any).data?.timing).toMatchObject({
    runnerPrewarmKind: 'session',
    runnerPrewarmScheduled: true,
    runnerPrewarmWaited: true,
    runnerPrewarmDurationMs: 250,
  });
  expect((response as any).data?.timing?.totalDurationMs).toBeGreaterThanOrEqual(250);
});

test('open --relaunch on iOS without existing session closes then opens target app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-new-session';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'ios-device-1',
    name: 'My iPhone',
    kind: 'device',
    booted: true,
  });

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['com.example.app'],
      flags: { relaunch: true, platform: 'ios' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual(['stop-runner', 'close:com.example.app', 'open:com.example.app']);
});

test('open --relaunch on iOS simulator settles once after the collapsed open', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 16',
      kind: 'simulator',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 16',
    kind: 'simulator',
    booted: true,
  });
  const settleCalls: Array<{ deviceId: string; delayMs: number }> = [];
  mockSettleSimulator.mockImplementation(async (device, delayMs) => {
    settleCalls.push({ deviceId: device.id, delayMs });
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  // Collapsed simulator relaunch skips the post-close settle: one settle after open.
  expect(settleCalls).toEqual([{ deviceId: 'sim-1', delayMs: 300 }]);
});

test('close on macOS session stops runner and dismisses automation alert before delete', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-macos-local',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    appBundleId: 'com.apple.systempreferences',
    appName: 'System Settings',
  });

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

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual([
    'stop-runner:host-macos-local',
    'dismiss-alert:dismiss:com.apple.systempreferences',
  ]);
  expect(sessionStore.get(sessionName)).toBe(undefined);
});

test('close on iOS simulator session retains runner and deletes the session', async () => {
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
    appName: 'com.example.app',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockStopIosRunner).not.toHaveBeenCalled();
  expect(mockScheduleIosRunnerIdleStop).toHaveBeenCalledWith('sim-1');
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close on iOS simulator with scoped simulator set stops runner before deleting session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-scoped-simulator-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
      simulatorSetPath: '/tmp/tenant-a/simulator-set',
    }),
    appName: 'com.example.app',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockStopIosRunner).toHaveBeenCalledWith('sim-1');
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close on leased iOS simulator session stops runner before deleting session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-leased-simulator-session';
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseBackend: 'ios-simulator',
    deviceKey: 'ios:sim-1',
    clientId: 'client-a',
  });
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
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
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    leaseRegistry,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockStopIosRunner).toHaveBeenCalledWith('sim-1');
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close --shutdown on iOS simulator stops runner before deleting session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-shutdown-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockStopIosRunner).toHaveBeenCalledWith('sim-1');
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close <app> on iOS stops runner before app close dispatch and performs final idempotent stop', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-close-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'My iPhone',
      kind: 'device',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual(['stop-runner', 'close:com.example.app', 'stop-runner']);
});

test('close <app> on iOS simulator retains runner while terminating app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-close-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appName: 'com.example.app',
  });

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${positionals.join(' ')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual(['close:com.example.app']);
});

test('app-only close terminates an iOS simulator app without ending its session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-app-only-close';
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

  mockDispatch.mockImplementation(async () => ({}));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      internal: { closeAppOnly: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
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
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-close-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-macos-local',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    appBundleId: 'com.apple.systempreferences',
    appName: 'System Settings',
  });

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
    calls.push(`${command}:${positionals.join(' ')}`);
    return {};
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['System Settings'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toEqual([
    'stop-runner:host-macos-local',
    'dismiss-alert:dismiss:com.apple.systempreferences',
    'close:System Settings',
    'stop-runner:host-macos-local',
    'dismiss-alert:dismiss:com.apple.systempreferences',
  ]);
});
