import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveAndroidPackageForOpen } from '@agent-device/platform-android/mechanics';
import { resolveSessionAppBundleIdForTarget } from '../../../../platform-runtime-open-target.ts';

vi.mock('@agent-device/platform-android/mechanics', () => ({
  resolveAndroidPackageForOpen: vi.fn(),
}));

const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);
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
