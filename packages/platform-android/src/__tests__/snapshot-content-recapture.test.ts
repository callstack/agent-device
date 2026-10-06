import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../adb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adb.ts')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '../adb.ts';
import { snapshotAndroid } from '../snapshot.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import {
  androidSystemWindowOnlyXml,
  createPersistentSnapshotHelperProvider,
  type FakeAndroidProcess,
} from './snapshot-helper-session.fixtures.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

beforeEach(async () => {
  await resetAndroidSnapshotHelperSessions();
  resetAndroidSnapshotHelperInstallCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetAndroidSnapshotHelperSessions();
});

/**
 * Captures of a busy screen that each answer with system chrome only, after `captureCostMs`.
 * Every sleep advances the clock by the time it was asked to wait.
 */
async function captureBusyScreen(captureCostMs: number): Promise<{
  error: unknown;
  sessionCaptures: number;
}> {
  let clockOffsetMs = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs);
  vi.mocked(sleep).mockImplementation(async (ms: number) => {
    clockOffsetMs += ms;
  });
  let sessionCaptures = 0;
  const provider = createPersistentSnapshotHelperProvider({
    calls: [],
    spawnArgs: [],
    processes: [] as FakeAndroidProcess[],
    sessionXml: () => {
      sessionCaptures += 1;
      clockOffsetMs += captureCostMs;
      return androidSystemWindowOnlyXml();
    },
  });
  const error = await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    appBundleId: 'com.example.app',
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { error, sessionCaptures };
}

test('a busy screen whose captures are cheap is re-captured before its verdict', async () => {
  const { error, sessionCaptures } = await captureBusyScreen(10);

  assert.ok(error instanceof AppError);
  assert.equal(error.details?.attempts, 3);
  assert.equal(sessionCaptures, 3);
});

test('a busy screen whose captures are slow is not re-captured past the window', async () => {
  // One attempt that spends a whole helper command budget leaves no room in the daemon request
  // envelope for two more of the same.
  const { error, sessionCaptures } = await captureBusyScreen(30_000);

  assert.ok(error instanceof AppError);
  assert.equal(error.details?.attempts, 1);
  assert.equal(sessionCaptures, 1);
});

test('a busy screen is not re-captured when the delay before it crosses the window', async () => {
  const { error, sessionCaptures } = await captureBusyScreen(9_900);

  assert.ok(error instanceof AppError);
  assert.equal(error.details?.attempts, 1);
  assert.equal(sessionCaptures, 1);
});
