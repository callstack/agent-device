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

test('inferAndroidPackageAfterOpen leaves a non-deep-link target unchanged', async () => {
  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'com.example.demo', undefined),
  ).resolves.toBeUndefined();
  expect(getAndroidAppState).not.toHaveBeenCalled();
});

test('inferAndroidPackageAfterOpen swallows a foreground-state read failure', async () => {
  getAndroidAppState.mockRejectedValue(new Error('adb connection dropped'));

  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'exp://127.0.0.1:8082', undefined),
  ).resolves.toBeUndefined();
});
