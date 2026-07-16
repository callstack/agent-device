import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { isActiveProviderDevice } from '../../../provider-device-runtime.ts';
import { IOS_SIMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import { getAndroidAppState } from '../../../platforms/android/app-lifecycle.ts';
import {
  inferAndroidPackageAfterOpen,
  resolveSessionAppBundleIdForTarget,
} from '../session-open-target.ts';

vi.mock('../../../provider-device-runtime.ts', () => ({
  isActiveProviderDevice: vi.fn(() => false),
}));
vi.mock('../../../platforms/android/app-lifecycle.ts', () => ({
  getAndroidAppState: vi.fn(),
}));

const mockIsActiveProviderDevice = vi.mocked(isActiveProviderDevice);
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const androidDevice: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel Emulator',
  kind: 'emulator',
  booted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsActiveProviderDevice.mockReturnValue(false);
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

test('provider iOS keeps the known bundle id without local app resolution', async () => {
  mockIsActiveProviderDevice.mockReturnValue(true);
  const resolveAndroidPackageForOpen = vi.fn(async () => 'com.example.android');

  const bundleId = await resolveSessionAppBundleIdForTarget(
    IOS_SIMULATOR,
    'com.example.demo',
    'com.example.installed',
    resolveAndroidPackageForOpen,
  );

  expect(bundleId).toBe('com.example.installed');
  expect(resolveAndroidPackageForOpen).not.toHaveBeenCalled();
});
