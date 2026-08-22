import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { getAndroidAppState } from '../../../platforms/android/window-state.ts';
import {
  inferAndroidPackageAfterOpen,
  resolveSessionAppBundleIdForTarget,
} from '../../../platform-runtime-open-target.ts';

vi.mock('../../../platforms/android/window-state.ts', () => ({
  getAndroidAppState: vi.fn(),
}));

const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const androidDevice: DeviceInfo = {
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

test('inferAndroidPackageAfterOpen reads foreground package for Android URL opens', async () => {
  mockGetAndroidAppState.mockResolvedValue({
    package: 'host.exp.exponent',
    activity: 'host.exp.exponent.experience.ExperienceActivity',
  });

  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'exp://127.0.0.1:8082', undefined),
  ).resolves.toBe('host.exp.exponent');
});

test('HarmonyOS adopts an explicit bundle-id target for app-scoped commands', async () => {
  const resolveAndroidPackageForOpen = vi.fn(async () => undefined);

  await expect(
    resolveSessionAppBundleIdForTarget(
      harmonyDevice,
      'com.example.application',
      undefined,
      resolveAndroidPackageForOpen,
    ),
  ).resolves.toBe('com.example.application');
  expect(resolveAndroidPackageForOpen).not.toHaveBeenCalled();
});

test.each(['myapp://login', 'https://example.com', 'Demo App'])(
  'HarmonyOS retains the existing app across non-bundle targets: %s',
  async (openTarget) => {
    await expect(
      resolveSessionAppBundleIdForTarget(
        harmonyDevice,
        openTarget,
        'com.example.application',
        vi.fn(async () => undefined),
      ),
    ).resolves.toBe('com.example.application');
  },
);
