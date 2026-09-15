import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  ANDROID_SNAPSHOT_HELPER_NO_HELPER_ANSWER,
  isAndroidSnapshotHelperRuntimeOccupiedError,
  recoverAndroidSnapshotHelperRetirement,
  recordAndroidSnapshotHelperRelease,
  resetAndroidSnapshotHelperRetirements,
  retireCanceledAndroidSnapshotHelperCapture,
  settleAndroidSnapshotHelperSessionCleanup,
} from '../snapshot-helper-retirement.ts';
import type { AndroidAdbExecutorResult, AndroidAdbProcess } from '../adb-executor.ts';
import type { AndroidAdbExecutor } from '../snapshot-helper-types.ts';
import {
  androidHelperRuntimeProbeResult,
  isAndroidHelperRuntimeProbe,
} from './snapshot-helper-session.fixtures.ts';

const PACKAGE_NAME = 'com.callstack.agentdevice.snapshothelper';
const DEVICE_KEY = 'android:emulator-5554';
// The device is asked for the helper process and told to echo a marker when there is none, so a
// release can only come from a shell that ran the command.
const RUNTIME_PROBE_CALL = [
  'shell',
  'pidof',
  PACKAGE_NAME,
  '||',
  'echo',
  ANDROID_SNAPSHOT_HELPER_NO_HELPER_ANSWER,
];

beforeEach(() => {
  resetAndroidSnapshotHelperRetirements();
});

test('canceled capture answers for the device, not for the force-stop call that served it', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args.includes('force-stop')) throw new Error('adb round trip exceeded its budget');
    if (isAndroidHelperRuntimeProbe(args)) return androidHelperRuntimeProbeResult('released');
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  // A loaded host makes the stop call time out while the helper process is already gone. Ownership
  // is decided by the process Android reports, so this retirement resolves.
  await retireCanceledAndroidSnapshotHelperCapture({
    deviceKey: DEVICE_KEY,
    packageName: PACKAGE_NAME,
    adb,
    cause: new Error('capture canceled'),
  });

  assert.deepEqual(calls, [['shell', 'am', 'force-stop', PACKAGE_NAME], RUNTIME_PROBE_CALL]);
  await recoverAndroidSnapshotHelperRetirement({ deviceKey: DEVICE_KEY, adb });
  assert.equal(calls.length, 2);
});

test('unproven release stays pending until an acquire reads the device', async () => {
  let helperAlive = true;
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (isAndroidHelperRuntimeProbe(args)) {
      return androidHelperRuntimeProbeResult(helperAlive ? 'occupied' : 'released');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  await retireCanceledAndroidSnapshotHelperCapture({
    deviceKey: DEVICE_KEY,
    packageName: PACKAGE_NAME,
    adb,
    cause: new Error('capture canceled'),
  });
  assert.deepEqual(calls, [['shell', 'am', 'force-stop', PACKAGE_NAME], RUNTIME_PROBE_CALL]);

  await assert.rejects(
    recoverAndroidSnapshotHelperRetirement({ deviceKey: DEVICE_KEY, adb }),
    isAndroidSnapshotHelperRuntimeOccupiedError,
  );
  // A refusal is the strongest thing an acquire does with this read, so it is earned by a force-stop
  // and two reads that both name the process.
  assert.deepEqual(calls.slice(2), [
    ['shell', 'am', 'force-stop', PACKAGE_NAME],
    RUNTIME_PROBE_CALL,
    RUNTIME_PROBE_CALL,
  ]);

  helperAlive = false;
  await recoverAndroidSnapshotHelperRetirement({ deviceKey: DEVICE_KEY, adb });
  assert.deepEqual(calls.slice(5), [
    ['shell', 'am', 'force-stop', PACKAGE_NAME],
    RUNTIME_PROBE_CALL,
  ]);

  // The release is proven, so the entry is gone and a further acquire has nothing to settle.
  await recoverAndroidSnapshotHelperRetirement({ deviceKey: DEVICE_KEY, adb });
  assert.equal(calls.length, 7);
});

test('a device that cannot be read leaves the retirement pending without failing the command', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (isAndroidHelperRuntimeProbe(args)) return androidHelperRuntimeProbeResult('unreadable');
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const release = await recordAndroidSnapshotHelperRelease({
    deviceKey: DEVICE_KEY,
    packageName: PACKAGE_NAME,
    adb,
    cause: new Error('quit timed out'),
  });
  assert.equal(release, 'unknown');

  // `adb` answered with its own transport fault, which says nothing about the helper process. The
  // acquire stops the runtime and asks again, and keeps doing that on every command until the device
  // can be read — unless a session reaches ready first, which settles it from the other end.
  await recoverAndroidSnapshotHelperRetirement({ deviceKey: DEVICE_KEY, adb });
  assert.deepEqual(calls.slice(1), [
    ['shell', 'am', 'force-stop', PACKAGE_NAME],
    RUNTIME_PROBE_CALL,
  ]);
  await recoverAndroidSnapshotHelperRetirement({ deviceKey: DEVICE_KEY, adb });
  assert.deepEqual(calls.slice(3), [
    ['shell', 'am', 'force-stop', PACKAGE_NAME],
    RUNTIME_PROBE_CALL,
  ]);
});

test('a read that names no process is released only when the device shell echoed the answer', async () => {
  // A release is the device shell echoing the marker and nothing else. Every shape below is adb or the
  // shell describing itself, and a description of the transport cannot clear a pending release.
  // Enumerating the ways a transport fails is not a fix either: that list is long, version-dependent,
  // and includes plain `error: closed` and `cannot connect to daemon`.
  const nonAnswers: AndroidAdbExecutorResult[] = [
    { exitCode: 1, stdout: '', stderr: 'error: closed' },
    { exitCode: 1, stdout: '', stderr: 'error: device offline' },
    { exitCode: 1, stdout: '', stderr: 'adb: cannot connect to daemon' },
    { exitCode: 1, stdout: '', stderr: 'failed to get feature set: device offline' },
    { exitCode: 1, stdout: '/system/bin/sh: pidof: not found', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    {
      exitCode: 0,
      stdout: ANDROID_SNAPSHOT_HELPER_NO_HELPER_ANSWER,
      stderr: '/system/bin/sh: pidof: not found',
    },
    { exitCode: 0, stdout: `${ANDROID_SNAPSHOT_HELPER_NO_HELPER_ANSWER} trailing`, stderr: '' },
  ];

  for (const answer of nonAnswers) {
    resetAndroidSnapshotHelperRetirements();
    const adb: AndroidAdbExecutor = async () => answer;

    const release = await recordAndroidSnapshotHelperRelease({
      deviceKey: DEVICE_KEY,
      packageName: PACKAGE_NAME,
      adb,
      cause: new Error('quit timed out'),
    });

    assert.equal(release, 'unknown', `answered ${JSON.stringify(answer)}`);
  }
});

test('an adb killed before it answers is not a release, whatever exit code it left behind', async () => {
  // A client killed by a signal — `pkill adb`, a host OOM kill, a concurrent `adb kill-server` — dies
  // without writing anything, and the executor reports an exit code it invented for the missing one.
  // Nothing on a stream is the transport saying it never reached the device, which is not evidence
  // that the helper is gone; clearing here would let the next acquire skip its force-stop while the
  // old helper still runs, and start a second instrumentation beside it.
  const release = await recordAndroidSnapshotHelperRelease({
    deviceKey: DEVICE_KEY,
    packageName: PACKAGE_NAME,
    adb: async () => androidHelperRuntimeProbeResult('signalled'),
    cause: new Error('quit timed out'),
  });

  assert.equal(release, 'unknown');
});

test('a device that echoes the answer is read as released', async () => {
  const calls: string[][] = [];
  const release = await recordAndroidSnapshotHelperRelease({
    deviceKey: DEVICE_KEY,
    packageName: PACKAGE_NAME,
    adb: async (args) => {
      calls.push(args);
      return androidHelperRuntimeProbeResult('released');
    },
    cause: new Error('quit timed out'),
  });

  assert.equal(release, 'released');
  await recoverAndroidSnapshotHelperRetirement({
    deviceKey: DEVICE_KEY,
    adb: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  assert.deepEqual(calls, [RUNTIME_PROBE_CALL]);
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
