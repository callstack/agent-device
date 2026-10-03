import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('../platform-runtime-android-mechanics.ts', () => ({
  loadAndroidMechanics: vi.fn(async () => {
    throw new Error('adb host unavailable');
  }),
}));

import { loadAndroidMechanics } from '../platform-runtime-android-mechanics.ts';
import { createAndroidApplicationTools } from '../platform-runtime-android-application-tools.ts';

const mockLoadAndroidMechanics = vi.mocked(loadAndroidMechanics);

beforeEach(() => {
  mockLoadAndroidMechanics.mockClear();
});

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel 9 Pro XL',
  kind: 'emulator',
  booted: true,
};

test('inferOpenedAppBundleId stays best-effort when Android mechanics fails to load for a targetless open', async () => {
  await expect(
    createAndroidApplicationTools().inferOpenedAppBundleId(device, undefined, undefined),
  ).resolves.toBeUndefined();
});

test('inferOpenedAppBundleId skips loading Android mechanics when the app-bundle identity is already known', async () => {
  await expect(
    createAndroidApplicationTools().inferOpenedAppBundleId(
      device,
      'exp://127.0.0.1:8082',
      'com.example.demo',
    ),
  ).resolves.toBe('com.example.demo');
  expect(mockLoadAndroidMechanics).not.toHaveBeenCalled();
});
