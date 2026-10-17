import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveAndroidPackageForOpen } from '@agent-device/platform-android/mechanics';
import {
  resolveIosApp,
  resolveIosSimulatorDeepLinkBundleId,
} from '@agent-device/platform-apple/app-resolution';
import { AppError } from '@agent-device/kernel/errors';
import {
  resolveRequestedOpenSurface,
  resolveSessionAppBundleIdForTarget,
} from './platform-runtime-open-target.ts';

vi.mock('@agent-device/platform-android/mechanics', () => ({
  resolveAndroidPackageForOpen: vi.fn(),
}));
vi.mock('@agent-device/platform-apple/app-resolution', () => ({
  resolveIosApp: vi.fn(),
  resolveIosSimulatorDeepLinkBundleId: vi.fn(),
}));

const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);
const mockResolveIosApp = vi.mocked(resolveIosApp);
const mockResolveIosSimulatorDeepLinkBundleId = vi.mocked(resolveIosSimulatorDeepLinkBundleId);
const iosDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-device-1',
  name: 'iPhone Device',
  kind: 'device',
  booted: true,
};
const iosSimulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-simulator-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};
const macOsDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-mac',
  name: 'Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};
const androidEmulator: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel Emulator',
  kind: 'emulator',
  booted: true,
};
const harmonyDevice: DeviceInfo = {
  platform: 'harmonyos',
  id: '127.0.0.1:5555',
  name: 'HarmonyOS Emulator',
  kind: 'emulator',
  booted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

test('HarmonyOS adopts an explicit bundle-id target for app-scoped commands', async () => {
  await expect(
    resolveSessionAppBundleIdForTarget(harmonyDevice, 'com.example.application', undefined),
  ).resolves.toBe('com.example.application');
  expect(mockResolveAndroidPackage).not.toHaveBeenCalled();
});

test.each(['myapp://login', 'https://example.com', 'Demo App'])(
  'HarmonyOS retains the existing app across non-bundle targets: %s',
  async (openTarget) => {
    await expect(
      resolveSessionAppBundleIdForTarget(harmonyDevice, openTarget, 'com.example.application'),
    ).resolves.toBe('com.example.application');
  },
);

test.each([
  ['an iOS device', iosDevice],
  ['an iOS simulator', iosSimulator],
])('a web URL on %s with no active app targets Safari', async (_label, device) => {
  await expect(
    resolveSessionAppBundleIdForTarget(device, 'https://example.com/path', undefined),
  ).resolves.toBe('com.apple.mobilesafari');
  expect(mockResolveIosApp).not.toHaveBeenCalled();
});

test('a web URL on an iOS simulator targets Safari whatever the active app is', async () => {
  await expect(
    resolveSessionAppBundleIdForTarget(iosSimulator, 'https://example.com/path', 'com.example.old'),
  ).resolves.toBe('com.apple.mobilesafari');
  expect(mockResolveIosApp).not.toHaveBeenCalled();
});

test('a web URL on an iOS device keeps the active app context', async () => {
  await expect(
    resolveSessionAppBundleIdForTarget(iosDevice, 'https://example.com/path', 'com.example.app'),
  ).resolves.toBe('com.example.app');
});

test.each([
  ['an iOS device', iosDevice, 'Settings', 'com.apple.Preferences'],
  ['a macOS device', macOsDevice, 'settings', 'com.apple.systempreferences'],
])('an app name on %s resolves through the Apple app resolver', async (_l, device, target, id) => {
  mockResolveIosApp.mockResolvedValueOnce(id);

  await expect(resolveSessionAppBundleIdForTarget(device, target, 'com.example.old')).resolves.toBe(
    id,
  );
  expect(mockResolveIosApp).toHaveBeenCalledWith(device, target);
});

test('a URL on a macOS session clears the stale app bundle id', async () => {
  await expect(
    resolveSessionAppBundleIdForTarget(macOsDevice, 'https://example.com/path', 'com.example.old'),
  ).resolves.toBeUndefined();
});

test.each([
  ['an iOS device', iosDevice],
  ['an iOS simulator', iosSimulator],
])('a custom URL on %s keeps the active app bundle id', async (_label, device) => {
  await expect(
    resolveSessionAppBundleIdForTarget(device, 'myapp://item/42', 'com.example.app'),
  ).resolves.toBe('com.example.app');
  expect(mockResolveIosSimulatorDeepLinkBundleId).not.toHaveBeenCalled();
});

test('a custom URL on a fresh iOS simulator infers the app bundle id from the URL scheme', async () => {
  mockResolveIosSimulatorDeepLinkBundleId.mockResolvedValueOnce('org.reactnavigation.playground');

  await expect(
    resolveSessionAppBundleIdForTarget(iosSimulator, 'rne://navigator-layout', undefined),
  ).resolves.toBe('org.reactnavigation.playground');
  expect(mockResolveIosSimulatorDeepLinkBundleId).toHaveBeenCalledWith(
    iosSimulator,
    'rne://navigator-layout',
  );
});

test('an Android app name resolves to the installed package', async () => {
  mockResolveAndroidPackage.mockResolvedValueOnce('org.reactjs.native.example.RNCLI83');

  await expect(
    resolveSessionAppBundleIdForTarget(androidEmulator, 'RNCLI83', undefined),
  ).resolves.toBe('org.reactjs.native.example.RNCLI83');
});

test('an Android intent target drops the stale package context', async () => {
  mockResolveAndroidPackage.mockResolvedValueOnce(undefined);

  await expect(
    resolveSessionAppBundleIdForTarget(androidEmulator, 'settings', 'com.example.old'),
  ).resolves.toBeUndefined();
});

test('an Android deep link keeps the current package context', async () => {
  mockResolveAndroidPackage.mockResolvedValueOnce(undefined);

  await expect(
    resolveSessionAppBundleIdForTarget(androidEmulator, 'myapp://screen', 'com.example.old'),
  ).resolves.toBe('com.example.old');
});

test('resolveRequestedOpenSurface keeps the stored macOS surface when no --surface flag is given', () => {
  expect(
    resolveRequestedOpenSurface({
      device: macOsDevice,
      surfaceFlag: undefined,
      openTarget: undefined,
      existingSurface: 'frontmost-app',
    }),
  ).toBe('frontmost-app');
});

test('resolveRequestedOpenSurface rejects surface flag on iOS', () => {
  const resolveDesktopSurface = () =>
    resolveRequestedOpenSurface({
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 17',
        kind: 'simulator',
      },
      surfaceFlag: 'desktop',
      openTarget: undefined,
    });

  expect(resolveDesktopSurface).toThrow(AppError);
  expect(resolveDesktopSurface).toThrow(/surface is only supported on macOS/i);
  try {
    resolveDesktopSurface();
  } catch (error) {
    expect((error as AppError).code).toBe('INVALID_ARGS');
  }
});
