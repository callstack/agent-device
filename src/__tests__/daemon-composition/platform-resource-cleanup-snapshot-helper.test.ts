import { beforeEach, expect, test, vi } from 'vitest';

// Root composition owns the rule that only an Android device has an adb snapshot-helper session to
// stop. The daemon never names this leaf: it calls the composed `platformResourceCleanup` port, so
// the rule is pinned here against the real composed module over the mocked mechanics leaf.
const mockStopAndroidSnapshotHelperSessionForDevice = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    stopAndroidSnapshotHelperSessionForDevice: mockStopAndroidSnapshotHelperSessionForDevice,
  };
});

import { ANDROID_EMULATOR, IOS_SIMULATOR } from '@agent-device/test-kit';
import { platformResourceCleanup } from '../../platform-runtime-resource-cleanup.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

test('the composed cleanup stops the snapshot helper for an Android device', async () => {
  await platformResourceCleanup.stopSnapshotHelper(ANDROID_EMULATOR);

  expect(mockStopAndroidSnapshotHelperSessionForDevice).toHaveBeenCalledExactlyOnceWith(
    ANDROID_EMULATOR,
  );
});

test('the composed cleanup names no snapshot helper for a non-Android device', async () => {
  await platformResourceCleanup.stopSnapshotHelper(IOS_SIMULATOR);

  expect(mockStopAndroidSnapshotHelperSessionForDevice).not.toHaveBeenCalled();
});
