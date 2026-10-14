import { test, expect } from 'vitest';
import * as path from 'node:path';
import {
  mockLifecycleDispatch as mockDispatch,
  mockResolveTargetDevice,
  mockResolveAndroidPackage,
  mockRunCmd,
  makeSessionStore,
  makeSession,
  noopInvoke,
  assertInvalidArgsMessage,
} from '@agent-device/daemon/testing/handlers/__tests__/session-test-harness';
import { handleSessionCommands as handleHarnessSessionCommands } from '@agent-device/daemon/testing/handlers/__tests__/session-command-harness';
import { composedLifecycleRuntimeFixture } from '../application-lifecycle-runtime-fixture.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { fakeCreateCommandSurface } from '@agent-device/daemon/testing/__tests__/support/command-surface-fake';
import { composedPlatformServicesFixture } from '../platform-services-fixture.ts';

// These open cases pin what the REAL composed open-target and surface rules answer through the
// daemon open flow: the Safari and deep-link fallbacks, iOS and Android target resolution, the
// macOS frontmost surface, and the non-desktop `--surface` refusal. The daemon-lane port fixture
// answers those asks with canned spies (its own siblings pin the daemon's open bookkeeping), so
// the rule-pinning cases run here against the real composed services AND the real composed
// lifecycle. The harness takes the lifecycle-operations loader per call, exactly like the gateway
// factories, so no module-global install or import-order dependency is involved.
const handleSessionCommands = (params: Parameters<typeof handleHarnessSessionCommands>[0]) =>
  handleHarnessSessionCommands({
    ...params,
    lifecycleOperationsLoader: composedLifecycleRuntimeFixture,
  });

test('open web URL on iOS device session without active app falls back to Safari', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.publish(
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['https://example.com/path'],
      flags: {},
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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

test('open web URL on iOS simulator session without active app falls back to Safari', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-simulator-session';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-simulator-1',
      name: 'iPhone Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'ios-simulator-1',
    name: 'iPhone Simulator',
    kind: 'simulator',
    booted: true,
  });

  let dispatchedContext: Record<string, unknown> | undefined;
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
    dispatchedContext = context as Record<string, unknown> | undefined;
    return {};
  });

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['https://example.com/path'],
      flags: {},
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
  sessionStore.publish(sessionName, {
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Settings', 'myapp://screen/to'],
      flags: {},
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(response?.ok && response.data?.sessionReused).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.apple.Preferences');
  expect(updated?.appName).toBe('Settings');
  expect(dispatchedPositionals).toEqual(['Settings', 'myapp://screen/to']);
  expect(dispatchedContext?.appBundleId).toBe('com.apple.Preferences');
});

test('open app on existing macOS session resolves and stores bundle id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-session';
  sessionStore.publish(sessionName, {
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['settings'],
      flags: {},
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
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
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(response, 'surface is only supported on macOS and Linux');
});

test('open on existing macOS frontmost-app session preserves surface without --surface flag', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-frontmost-existing';
  sessionStore.publish(sessionName, {
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
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: composedPlatformServicesFixture(),
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
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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

test('open app on existing Android session resolves and stores package id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-session';
  sessionStore.publish(sessionName, {
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['RNCLI83'],
      flags: {},
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
  sessionStore.publish(sessionName, {
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['settings'],
      flags: {},
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
