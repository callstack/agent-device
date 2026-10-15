import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { test, expect, vi } from 'vitest';
import * as path from 'node:path';
import { buildSnapshotSignatures } from '@agent-device/capture-kit/snapshot-freshness';
import { AppError } from '@agent-device/kernel/errors';
import {
  mockLifecycleDispatch as mockDispatch,
  mockResolveTargetDevice,
  makeSessionStore,
  makeSession,
  noopInvoke,
  assertInvalidArgsMessage,
  withMockedPlatform,
} from '../../../../__tests__/support/handlers/session-test-harness.ts';
import { resolveOpenTargetFixture } from '../../../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import type { SessionState } from '../../../../core/session-state.ts';
import { handleSessionCommands } from '../../../../__tests__/support/handlers/session-command-harness.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';

const mockResolveOpenTarget = vi.mocked(resolveOpenTargetFixture);

test('open on existing iOS session refreshes unavailable simulator by name', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-session';
  sessionStore.publish(sessionName, {
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
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
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
    snapshot: {
      nodes: baselineNodes,
      createdAt: Date.now(),
      backend: 'android',
      comparisonSafe: true,
    },
  });

  mockDispatch.mockResolvedValue(undefined);

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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

test.each([
  {
    label: 'a web URL on an iOS device session with no active app',
    device: { platform: 'apple', id: 'ios-device-1', name: 'iPhone Device', kind: 'device' },
    existing: {},
    target: 'https://example.com/path',
    resolved: { appBundleId: 'com.apple.mobilesafari', appName: 'https://example.com/path' },
  },
  {
    label: 'a web URL on an iOS simulator session with no active app',
    device: {
      platform: 'apple',
      id: 'ios-simulator-1',
      name: 'iPhone Simulator',
      kind: 'simulator',
    },
    existing: {},
    target: 'https://example.com/path',
    resolved: { appBundleId: 'com.apple.mobilesafari', appName: 'https://example.com/path' },
  },
  {
    label: 'a web URL on an iOS simulator session with a stale app bundle id',
    device: {
      platform: 'apple',
      id: 'ios-simulator-1',
      name: 'iPhone Simulator',
      kind: 'simulator',
    },
    existing: { appBundleId: 'com.example.old', appName: 'Old App' },
    target: 'https://example.com/path',
    resolved: { appBundleId: 'com.apple.mobilesafari', appName: 'https://example.com/path' },
  },
  {
    label: 'an app name on a macOS session',
    device: {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-mac',
      name: 'Mac',
      kind: 'device',
      target: 'desktop',
    },
    existing: { appBundleId: 'com.example.old', appName: 'Old App' },
    target: 'settings',
    resolved: { appBundleId: 'com.apple.systempreferences', appName: 'settings' },
  },
  {
    label: 'an app name on an Android session',
    device: { platform: 'android', id: 'emulator-5554', name: 'Pixel Emulator', kind: 'emulator' },
    existing: { appName: 'Old App' },
    target: 'RNCLI83',
    resolved: { appBundleId: 'org.reactjs.native.example.RNCLI83', appName: 'RNCLI83' },
  },
  {
    label: 'an intent target on an Android session with a stale package',
    device: { platform: 'android', id: 'emulator-5554', name: 'Pixel Emulator', kind: 'emulator' },
    existing: { appBundleId: 'com.example.old', appName: 'Old App' },
    target: 'settings',
    resolved: { appBundleId: undefined, appName: 'settings' },
  },
] as const)(
  'open on an existing session stores the platform-resolved identity for $label',
  async ({ device, existing, target, resolved }) => {
    const sessionStore = makeSessionStore();
    const sessionName = 'existing-open-identity';
    sessionStore.publish(sessionName, {
      ...makeSession(sessionName, { ...device, booted: true } as SessionState['device']),
      ...existing,
    });
    mockResolveTargetDevice.mockResolvedValue({
      ...device,
      booted: true,
    } as SessionState['device']);
    let dispatchedContext: Record<string, unknown> | undefined;
    mockDispatch.mockImplementation(async (_device, _command, _positionals, _out, context) => {
      dispatchedContext = context as Record<string, unknown> | undefined;
      return {};
    });
    mockResolveOpenTarget.mockClear();
    mockResolveOpenTarget.mockResolvedValueOnce(resolved);

    const response = await handleSessionCommands({
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      req: {
        token: 't',
        session: sessionName,
        command: 'open',
        positionals: [target],
        flags: {},
      },
      sessionName,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    });

    expect(response?.ok).toBe(true);
    expect(mockResolveOpenTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: device.id }),
      expect.any(Function),
      expect.objectContaining({
        target,
        currentAppBundleId: 'appBundleId' in existing ? existing.appBundleId : undefined,
      }),
    );
    const updated = sessionStore.get(sessionName);
    expect(updated?.appBundleId).toBe(resolved.appBundleId);
    expect(updated?.appName).toBe(resolved.appName);
    expect(dispatchedContext?.appBundleId).toBe(resolved.appBundleId);
  },
);

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
  mockResolveOpenTarget.mockResolvedValueOnce({
    appBundleId: 'com.apple.Preferences',
    appName: 'Settings',
  });

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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

  expect(response?.ok).toBe(true);
  expect(response?.ok && response.data?.sessionReused).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.appBundleId).toBe('com.apple.Preferences');
  expect(updated?.appName).toBe('Settings');
  expect(dispatchedPositionals).toEqual(['Settings', 'myapp://screen/to']);
  expect(dispatchedContext?.appBundleId).toBe('com.apple.Preferences');
});

test('open reports a platform surface refusal as an INVALID_ARGS response', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });
  const resolveRequestedOpenSurface = vi.fn(() => {
    throw new AppError('INVALID_ARGS', 'surface is only supported on macOS and Linux');
  });

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture({ resolveRequestedOpenSurface }),
    req: {
      token: 't',
      session: 'ios-surface',
      command: 'open',
      positionals: ['Notes'],
      flags: { platform: 'ios', surface: 'frontmost-app' },
    },
    sessionName: 'ios-surface',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(response, 'surface is only supported on macOS and Linux');
  expect(resolveRequestedOpenSurface).toHaveBeenCalledWith(
    expect.objectContaining({ surfaceFlag: 'frontmost-app', openTarget: 'Notes' }),
  );
  expect(mockDispatch).not.toHaveBeenCalled();
});

test('open on existing macOS frontmost-app session carries the stored surface without a --surface flag', async () => {
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
  mockDispatch.mockImplementation(async (_device, _command, positionals) => {
    expect(positionals).toEqual([]);
    return {};
  });
  mockResolveOpenTarget.mockResolvedValueOnce({
    appBundleId: 'com.apple.TextEdit',
    appName: 'TextEdit',
  });

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: [],
      flags: { platform: 'macos' },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(mockResolveOpenTarget).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(Function),
    expect.objectContaining({ surface: 'frontmost-app' }),
  );
  const session = sessionStore.get(sessionName);
  expect(session?.surface).toBe('frontmost-app');
  expect(session?.appBundleId).toBe('com.apple.TextEdit');
  expect(session?.appName).toBe('TextEdit');
  if (response?.ok) expect(response.data?.surface).toBe('frontmost-app');
});
