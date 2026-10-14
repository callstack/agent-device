import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const resolveAndroidApp = vi.hoisted(() => vi.fn());
const getAndroidAppState = vi.hoisted(() => vi.fn());

vi.mock('./app-deployment-resolution.ts', () => ({ resolveAndroidApp }));
vi.mock('./window-state.ts', () => ({ getAndroidAppState }));

const { resolveAndroidPackageForOpen, inferAndroidPackageAfterOpen } =
  await import('./open-target-resolution.ts');

const androidDevice: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel Emulator',
  kind: 'emulator',
  booted: true,
};
const appleDevice: DeviceInfo = {
  platform: 'apple',
  id: '00000000-0000-0000-0000-000000000000',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

test('resolveAndroidPackageForOpen returns the resolved package for a package match', async () => {
  resolveAndroidApp.mockResolvedValue({ type: 'package', value: 'com.example.demo' });

  await expect(resolveAndroidPackageForOpen(androidDevice, 'demo')).resolves.toBe(
    'com.example.demo',
  );
});

test('resolveAndroidPackageForOpen ignores an intent resolution', async () => {
  resolveAndroidApp.mockResolvedValue({ type: 'intent', value: 'android.settings.SETTINGS' });

  await expect(resolveAndroidPackageForOpen(androidDevice, 'settings')).resolves.toBeUndefined();
});

test('resolveAndroidPackageForOpen swallows resolution failures', async () => {
  resolveAndroidApp.mockRejectedValue(new AppError('APP_NOT_INSTALLED', 'No package found'));

  await expect(resolveAndroidPackageForOpen(androidDevice, 'demo')).resolves.toBeUndefined();
  expect(resolveAndroidApp).toHaveBeenCalled();
});

test('resolveAndroidPackageForOpen skips non-Android devices without resolving', async () => {
  await expect(resolveAndroidPackageForOpen(appleDevice, 'demo')).resolves.toBeUndefined();
  expect(resolveAndroidApp).not.toHaveBeenCalled();
});

test('resolveAndroidPackageForOpen skips a deep-link target without resolving', async () => {
  await expect(
    resolveAndroidPackageForOpen(androidDevice, 'myapp://login'),
  ).resolves.toBeUndefined();
  expect(resolveAndroidApp).not.toHaveBeenCalled();
});

test('inferAndroidPackageAfterOpen reads the foreground package for a deep-link open', async () => {
  getAndroidAppState.mockResolvedValue({
    package: 'host.exp.exponent',
    activity: 'host.exp.exponent.experience.ExperienceActivity',
  });

  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'exp://127.0.0.1:8082', undefined),
  ).resolves.toBe('host.exp.exponent');
});

test('inferAndroidPackageAfterOpen keeps an already-known bundle id without reading state', async () => {
  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'exp://127.0.0.1:8082', 'com.example.demo'),
  ).resolves.toBe('com.example.demo');
  expect(getAndroidAppState).not.toHaveBeenCalled();
});

test('inferAndroidPackageAfterOpen reads the resumed package for an intent alias open', async () => {
  getAndroidAppState.mockResolvedValue({
    package: 'com.android.settings',
    activity: 'com.android.settings.Settings',
  });

  await expect(inferAndroidPackageAfterOpen(androidDevice, 'settings', undefined)).resolves.toBe(
    'com.android.settings',
  );
});

test('inferAndroidPackageAfterOpen never names the framework chooser as the owner', async () => {
  getAndroidAppState.mockResolvedValue({
    package: 'android',
    activity: 'com.android.internal.app.ResolverActivity',
  });

  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'https://example.com/item', undefined),
  ).resolves.toBeUndefined();
  expect(getAndroidAppState).toHaveBeenCalledWith(androidDevice);
});

test('inferAndroidPackageAfterOpen keeps the launched package under a permission prompt', async () => {
  getAndroidAppState.mockResolvedValue({
    package: 'com.google.android.permissioncontroller',
    activity: 'com.android.permissioncontroller.permission.ui.GrantPermissionsActivity',
  });

  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'myapp://login', undefined, 'com.example.app'),
  ).resolves.toBe('com.example.app');
});

test('inferAndroidPackageAfterOpen never names a launched framework chooser as the owner', async () => {
  getAndroidAppState.mockResolvedValue({ package: 'com.example.app' });

  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'settings', undefined, 'android'),
  ).resolves.toBeUndefined();
});

test('inferAndroidPackageAfterOpen swallows a foreground-state read failure', async () => {
  getAndroidAppState.mockRejectedValue(new Error('adb connection dropped'));

  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'exp://127.0.0.1:8082', undefined),
  ).resolves.toBeUndefined();
});
