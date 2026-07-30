import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import {
  recoverAndroidSnapshotHelperRetirement,
  resetAndroidSnapshotHelperRetirements,
  retireCanceledAndroidSnapshotHelperCapture,
} from '../snapshot-helper-retirement.ts';
import type { AndroidAdbExecutor } from '../snapshot-helper-types.ts';

beforeEach(() => {
  resetAndroidSnapshotHelperRetirements();
});

test('requires positive recovery evidence after uncertain runtime retirement', async () => {
  const calls: string[][] = [];
  let forceStopCount = 0;
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    forceStopCount += 1;
    return {
      exitCode: forceStopCount === 1 ? 1 : 0,
      stdout: '',
      stderr: forceStopCount === 1 ? 'runtime still busy' : '',
    };
  };

  await assert.rejects(
    retireCanceledAndroidSnapshotHelperCapture({
      deviceKey: 'android:emulator-5554',
      packageName: 'com.callstack.agentdevice.snapshothelper',
      adb,
      cause: new Error('capture canceled'),
    }),
    (error: unknown) =>
      (error as { details?: { reason?: string } }).details?.reason ===
      'android_snapshot_helper_retirement_unconfirmed',
  );
  await recoverAndroidSnapshotHelperRetirement({
    deviceKey: 'android:emulator-5554',
    adb,
  });
  await recoverAndroidSnapshotHelperRetirement({
    deviceKey: 'android:emulator-5554',
    adb,
  });

  assert.equal(forceStopCount, 2);
  assert.deepEqual(
    calls,
    Array.from({ length: 2 }, () => [
      'shell',
      'am',
      'force-stop',
      'com.callstack.agentdevice.snapshothelper',
    ]),
  );
});
