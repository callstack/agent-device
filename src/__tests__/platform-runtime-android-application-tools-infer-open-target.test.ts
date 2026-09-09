import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('../platform-runtime-android-mechanics.ts', () => ({
  loadAndroidMechanics: vi.fn(async () => {
    throw new Error('adb host unavailable');
  }),
}));

import { createAndroidApplicationTools } from '../platform-runtime-android-application-tools.ts';

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
