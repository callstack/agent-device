import { test, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSnapshotSignatures } from '../../android-snapshot-freshness.ts';
import { AppError } from '../../../kernel/errors.ts';
import {
  mockDispatch,
  mockResolveTargetDevice,
  mockResolveAndroidPackage,
  mockRunCmd,
  makeSessionStore,
  makeSession,
  noopInvoke,
  assertInvalidArgsMessage,
  withMockedPlatform,
} from './session-test-harness.ts';
import type { SessionState } from '../../types.ts';
import { handleSessionCommands } from '../session.ts';

test('open web URL on iOS device session without active app falls back to Safari', async () => {
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
  expect(updated?.appBundleId).toBe('com.apple.mobilesafari');
  expect(updated?.appName).toBe('https://example.com/path');
  expect(dispatchedContext?.appBundleId).toBe('com.apple.mobilesafari');
});

test('open app and URL on existing iOS device session keeps app context', async () => {
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

  let dispatchedPositionals: string[] | undefined;
  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, positionals, _out, context) => {
    dispatchedPositionals = positionals;
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
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
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.apple.Preferences');
  expect(updated?.appName).toBe('Settings');
  expect(dispatchedPositionals).toEqual(['Settings', 'myapp://screen/to']);
  expect(dispatchedContext?.appBundleId).toBe('com.apple.Preferences');
});

test('open app on existing macOS session resolves and stores bundle id', async () => {
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
      positionals: ['settings'],
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
  expect(updated?.appBundleId).toBe('com.apple.systempreferences');
  expect(updated?.appName).toBe('settings');
  expect(dispatchedContext?.appBundleId).toBe('com.apple.systempreferences');
});

test('open rejects --surface on non-macOS devices', async () => {
  const sessionStore = makeSessionStore();
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
      session: 'ios-surface',
      command: 'open',
      positionals: ['Notes'],
      flags: {
        platform: 'ios',
        surface: 'frontmost-app',
      },
    },
    sessionName: 'ios-surface',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(response, 'surface is only supported on macOS and Linux');
});

test('open on existing macOS frontmost-app session preserves surface without --surface flag', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-frontmost-existing';
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
    surface: 'frontmost-app',
    appBundleId: 'com.apple.TextEdit',
    appName: 'TextEdit',
  });

  const prevHelper = process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
  process.env.AGENT_DEVICE_MACOS_HELPER_BIN = '/usr/bin/true';
  mockRunCmd.mockResolvedValue({
    stdout: '{"ok":true,"data":{"bundleId":"com.apple.TextEdit","appName":"TextEdit","pid":123}}',
    stderr: '',
    exitCode: 0,
  });
  mockDispatch.mockImplementation(async (_device, _command, positionals) => {
    expect(positionals).toEqual([]);
    return {};
  });

  try {
    const response = await handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'open',
        positionals: [],
        flags: {
          platform: 'macos',
        },
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    });

    expect(response?.ok).toBe(true);
    const session = sessionStore.get(sessionName);
    expect(session?.surface).toBe('frontmost-app');
    expect(session?.appBundleId).toBe('com.apple.TextEdit');
    expect(session?.appName).toBe('TextEdit');
    if (response && response.ok) {
      expect(response.data?.surface).toBe('frontmost-app');
    }
  } finally {
    if (prevHelper === undefined) delete process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
    else process.env.AGENT_DEVICE_MACOS_HELPER_BIN = prevHelper;
  }
});

test('open on existing iOS session refreshes unavailable simulator by name', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-session';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'stale-sim',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: false,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
  });

  const resolvedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'fresh-sim',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  const selectors: Array<Record<string, unknown>> = [];
  let dispatchedDeviceId: string | undefined;

  mockResolveTargetDevice.mockImplementation(async (selector) => {
    selectors.push({ ...selector });
    if ((selector as any).udid === 'stale-sim') {
      throw new AppError('DEVICE_NOT_FOUND', 'not found');
    }
    return resolvedDevice;
  });
  mockDispatch.mockImplementation(async (device) => {
    dispatchedDeviceId = device.id;
    return {};
  });

  const response = await withMockedPlatform('darwin', async () =>
    handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'open',
        positionals: ['settings'],
        flags: {},
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  );

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(selectors.length).toBe(2);
  expect(selectors[0]).toEqual({ platform: 'ios', target: undefined, udid: 'stale-sim' });
  expect(selectors[1]).toEqual({ platform: 'ios', target: undefined, device: 'iPhone 17 Pro' });
  expect(dispatchedDeviceId).toBe('fresh-sim');
  const updated = sessionStore.get(sessionName);
  expect(updated?.device.id).toBe('fresh-sim');
  if (response && response.ok) {
    expect(response.data?.device_udid).toBe('fresh-sim');
  }
});

test('open app on existing Android session resolves and stores package id', async () => {
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
    appName: 'Old App',
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });
  mockResolveAndroidPackage.mockResolvedValue('org.reactjs.native.example.RNCLI83');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['RNCLI83'],
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
  expect(updated?.appBundleId).toBe('org.reactjs.native.example.RNCLI83');
  expect(updated?.appName).toBe('RNCLI83');
  expect(dispatchedContext?.appBundleId).toBe('org.reactjs.native.example.RNCLI83');
});

test('open intent target on existing Android session clears stale package context', async () => {
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
    appBundleId: 'com.example.old',
    appName: 'Old App',
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });
  mockResolveAndroidPackage.mockResolvedValue(undefined);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['settings'],
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
  expect(updated?.appName).toBe('settings');
  expect(dispatchedContext?.appBundleId).toBe(undefined);
});

test('open on existing Android session preserves a comparable freshness baseline', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-open-freshness';
  const baselineNodes = Array.from({ length: 14 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Inbox row ${index + 1}`,
  }));
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
    snapshot: {
      nodes: baselineNodes,
      createdAt: Date.now(),
      backend: 'android',
      comparisonSafe: true,
    },
  });

  mockDispatch.mockResolvedValue({});
  mockResolveAndroidPackage.mockResolvedValue('com.android.settings');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['settings'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.snapshot).toBeUndefined();
  expect(updated?.androidSnapshotFreshness).toEqual({
    action: 'open',
    markedAt: expect.any(Number),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  });
});
