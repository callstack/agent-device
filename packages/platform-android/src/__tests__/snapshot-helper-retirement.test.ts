import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  isAndroidSnapshotHelperRuntimeOccupiedError,
  recoverAndroidSnapshotHelperRetirement,
  recordAndroidSnapshotHelperRelease,
  resetAndroidSnapshotHelperRetirements,
  retireCanceledAndroidSnapshotHelperCapture,
  settleAndroidSnapshotHelperSessionCleanup,
} from '../snapshot-helper-retirement.ts';
import type { AndroidAdbProcess } from '../adb-executor.ts';
import type { AndroidAdbExecutor } from '../snapshot-helper-types.ts';

const PACKAGE_NAME = 'com.callstack.agentdevice.snapshothelper';
const DEVICE_KEY = 'android:emulator-5554';

beforeEach(() => {
  resetAndroidSnapshotHelperRetirements();
});

test('canceled capture answers for the device, not for the force-stop call that served it', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args.includes('force-stop')) throw new Error('adb round trip exceeded its budget');
    return { exitCode: 1, stdout: '', stderr: '' };
  };

  // A loaded host makes the stop call time out while the helper process is already gone. Ownership
  // is decided by the process Android reports, so this retirement resolves.
  await retireCanceledAndroidSnapshotHelperCapture({
    deviceKey: DEVICE_KEY,
    packageName: PACKAGE_NAME,
    adb,
    cause: new Error('capture canceled'),
  });

  assert.deepEqual(calls, [
    ['shell', 'am', 'force-stop', PACKAGE_NAME],
    ['shell', 'pidof', PACKAGE_NAME],
  ]);
  await recoverAndroidSnapshotHelperRetirement({ deviceKey: DEVICE_KEY, adb });
  assert.equal(calls.length, 2);
});

test('unproven release stays pending until an acquire reads the device', async () => {
  let helperAlive = true;
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('pidof')) {
      return helperAlive
        ? { exitCode: 0, stdout: '4211\n', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  await retireCanceledAndroidSnapshotHelperCapture({
    deviceKey: DEVICE_KEY,
    packageName: PACKAGE_NAME,
    adb,
    cause: new Error('capture canceled'),
  });

  await assert.rejects(
    recoverAndroidSnapshotHelperRetirement({ deviceKey: DEVICE_KEY, adb }),
    isAndroidSnapshotHelperRuntimeOccupiedError,
  );

  helperAlive = false;
  await recoverAndroidSnapshotHelperRetirement({ deviceKey: DEVICE_KEY, adb });
  await recoverAndroidSnapshotHelperRetirement({ deviceKey: DEVICE_KEY, adb });
});

test('a device that cannot be read leaves the retirement pending without failing the command', async () => {
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('pidof')) throw new Error('device offline');
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const release = await recordAndroidSnapshotHelperRelease({
    deviceKey: DEVICE_KEY,
    packageName: PACKAGE_NAME,
    adb,
    cause: new Error('quit timed out'),
  });
  assert.equal(release, 'unknown');
  await recoverAndroidSnapshotHelperRetirement({ deviceKey: DEVICE_KEY, adb });
});

test('session cleanup stops the runtime even when the transport refuses the stop', async () => {
  const calls: string[][] = [];
  const cleanup = await settleAndroidSnapshotHelperSessionCleanup({
    adb: recordingAdb(calls, () => ({ exitCode: 1, stdout: '', stderr: 'device offline' })),
    process: new StubAndroidProcess(),
    port: 41234,
    packageName: PACKAGE_NAME,
    timeoutMs: 2_000,
    forceStopRuntime: true,
  });

  // The stop is an action, never the release evidence; a refused call must not fail the teardown.
  assert.equal(cleanup.timedOut, false);
  assert.deepEqual(calls, [
    ['shell', 'am', 'force-stop', PACKAGE_NAME],
    ['forward', '--remove', 'tcp:41234'],
  ]);
});

test('session cleanup skips the force-stop round trip once release is confirmed', async () => {
  const calls: string[][] = [];
  const cleanup = await settleAndroidSnapshotHelperSessionCleanup({
    adb: recordingAdb(calls),
    process: new StubAndroidProcess(),
    port: 41234,
    packageName: PACKAGE_NAME,
    timeoutMs: 2_000,
    forceStopRuntime: false,
  });

  // The helper already released UiAutomation, so the only device call is the forward removal the
  // next session on this port would otherwise collide with.
  assert.equal(cleanup.timedOut, false);
  assert.deepEqual(calls, [['forward', '--remove', 'tcp:41234']]);
});

function recordingAdb(
  calls: string[][],
  result: () => { exitCode: number; stdout: string; stderr: string } = () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  }),
): AndroidAdbExecutor {
  return async (args) => {
    calls.push(args);
    return result();
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
