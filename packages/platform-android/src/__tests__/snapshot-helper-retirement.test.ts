import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  recoverAndroidSnapshotHelperRetirement,
  resetAndroidSnapshotHelperRetirements,
  retireCanceledAndroidSnapshotHelperCapture,
  settleAndroidSnapshotHelperSessionCleanup,
} from '../snapshot-helper-retirement.ts';
import type { AndroidAdbProcess } from '../adb-executor.ts';
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

test('session cleanup force-stops the runtime when release was not confirmed', async () => {
  const calls: string[][] = [];
  const cleanup = await settleAndroidSnapshotHelperSessionCleanup({
    adb: recordingAdb(calls),
    process: new StubAndroidProcess(),
    port: 41234,
    packageName: 'com.callstack.agentdevice.snapshothelper',
    timeoutMs: 2_000,
    forceStopRuntime: true,
  });

  assert.equal(cleanup.runtimeForceStopped, true);
  assert.deepEqual(calls, [
    ['shell', 'am', 'force-stop', 'com.callstack.agentdevice.snapshothelper'],
    ['forward', '--remove', 'tcp:41234'],
  ]);
});

test('session cleanup skips the force-stop round trip once release is confirmed', async () => {
  const calls: string[][] = [];
  const cleanup = await settleAndroidSnapshotHelperSessionCleanup({
    adb: recordingAdb(calls),
    process: new StubAndroidProcess(),
    port: 41234,
    packageName: 'com.callstack.agentdevice.snapshothelper',
    timeoutMs: 2_000,
    forceStopRuntime: false,
  });

  // The helper already released UiAutomation, so nothing was force-stopped and nothing may claim
  // it was: the caller reads this flag to decide whether the retirement needs quarantining.
  assert.equal(cleanup.runtimeForceStopped, false);
  assert.deepEqual(calls, [['forward', '--remove', 'tcp:41234']]);
});

function recordingAdb(calls: string[][]): AndroidAdbExecutor {
  return async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

class StubAndroidProcess extends EventEmitter implements AndroidAdbProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = 0;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}
