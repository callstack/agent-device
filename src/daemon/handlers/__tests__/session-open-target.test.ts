import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
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

// Opening a bundle id switches the session's app, so the target wins over what
// the session tracked before — the same precedence the local path has, where
// resolveIosApp returns a dotted target unchanged and never reads the current
// id. This case only became reachable once a first open started populating the
// id at all (#1658); preferring the stored value left `open com.a` then
// `open com.b` reporting com.a for every appBundleId-gated command after it.
test('provider iOS adopts a new bundle-id target over the tracked app', async () => {
  mockIsActiveProviderDevice.mockReturnValue(true);
  const resolveAndroidPackageForOpen = vi.fn(async () => 'com.example.android');

  const bundleId = await resolveSessionAppBundleIdForTarget(
    IOS_SIMULATOR,
    'com.example.demo',
    'com.example.installed',
    resolveAndroidPackageForOpen,
  );

  expect(bundleId).toBe('com.example.demo');
  expect(resolveAndroidPackageForOpen).not.toHaveBeenCalled();
});

test.each([
  ['a deep link', 'myapp://login'],
  ['a web URL', 'https://example.com'],
  ['an app display name', 'Demo App'],
  ['no target', undefined],
])('provider iOS keeps the tracked app across %s', async (_label, openTarget) => {
  mockIsActiveProviderDevice.mockReturnValue(true);

  await expect(
    resolveSessionAppBundleIdForTarget(
      IOS_SIMULATOR,
      openTarget,
      'com.example.installed',
      vi.fn(async () => 'com.example.android'),
    ),
  ).resolves.toBe('com.example.installed');
});

// #1658: a first open on a cloud device has no known bundle id, and no local
// tooling can look one up. Dropping the target left the session with no app
// identity at all, so every appBundleId-gated command refused a live session.
test('provider iOS adopts a bundle-id open target when none is known', async () => {
  mockIsActiveProviderDevice.mockReturnValue(true);
  const resolveAndroidPackageForOpen = vi.fn(async () => 'com.example.android');

  const bundleId = await resolveSessionAppBundleIdForTarget(
    IOS_SIMULATOR,
    'com.example.demo',
    undefined,
    resolveAndroidPackageForOpen,
  );

  expect(bundleId).toBe('com.example.demo');
  expect(resolveAndroidPackageForOpen).not.toHaveBeenCalled();
});

test.each([
  ['an app display name', 'Demo App'],
  ['a deep link', 'myapp://login'],
  ['a web URL', 'https://example.com'],
  ['no target', undefined],
])('provider iOS adopts nothing from %s', async (_label, openTarget) => {
  mockIsActiveProviderDevice.mockReturnValue(true);

  await expect(
    resolveSessionAppBundleIdForTarget(
      IOS_SIMULATOR,
      openTarget,
      undefined,
      vi.fn(async () => undefined),
    ),
  ).resolves.toBeUndefined();
});
