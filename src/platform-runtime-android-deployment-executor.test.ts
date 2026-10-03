import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const resolveAndroidApp = vi.hoisted(() => vi.fn());
vi.mock('@agent-device/platform-android/mechanics', () => ({
  resolveAndroidApp,
  withAndroidAppResolutionCacheInvalidated: async <Result>(
    _device: DeviceInfo,
    operation: () => Promise<Result>,
  ) => await operation(),
}));

import { createAndroidAppDeploymentExecutor } from './platform-runtime-android-deployment-executor.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'android-executor',
  name: 'Android executor',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test('keeps root composition limited to artifact preparation and app identity resolution', async () => {
  resolveAndroidApp.mockResolvedValueOnce({ type: 'package', value: 'com.example.app' });
  const executor = createAndroidAppDeploymentExecutor();

  await expect(executor.resolveAppPackage(device, 'Example')).resolves.toBe('com.example.app');
  expect(resolveAndroidApp).toHaveBeenCalledWith(device, 'Example');
  expect(Object.keys(executor).sort()).toEqual([
    'bundletoolJar',
    'prepareArtifact',
    'resolveAppPackage',
    'withInvalidatedAppResolutionCache',
  ]);
});

test('rejects an intent where uninstall requires an exact Android package', async () => {
  resolveAndroidApp.mockResolvedValueOnce({ type: 'intent', value: 'example.intent' });

  await expect(
    createAndroidAppDeploymentExecutor().resolveAppPackage(device, 'example.intent'),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
});
