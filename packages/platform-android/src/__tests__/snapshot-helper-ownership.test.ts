import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { isUnreadableCaptureContentError } from '@agent-device/contracts/android-snapshot-quality';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { snapshotAndroid } from '../snapshot.ts';
import { captureAndroidSnapshotWithHelperSession } from '../snapshot-helper-session.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import {
  androidSystemWindowOnlyXml,
  createPersistentSnapshotHelperProvider,
  createSessionProvider,
  isAndroidHelperRuntimeForceStop,
  type FakeAndroidProcess,
} from './snapshot-helper-session.fixtures.ts';

vi.mock('../adb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adb.ts')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};
const helperArtifact = ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT;

beforeEach(async () => {
  await resetAndroidSnapshotHelperSessions();
  resetAndroidSnapshotHelperInstallCache();
});

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

test('a command capture releases a new helper and preserves an existing daemon helper', async () => {
  const calls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({ calls, spawnArgs, processes });
  const options = { helperAdb: provider, helperArtifact };

  await snapshotAndroid(device, options);
  assert.equal(processes[0]?.exitCode, 0);

  await snapshotAndroid(device, { ...options, helperSessionScope: 'daemon-session' });
  const observed = await snapshotAndroid(device, options);
  const next = await snapshotAndroid(device, { ...options, helperSessionScope: 'daemon-session' });

  assert.equal(observed.androidSnapshot.helperSessionReused, true);
  assert.equal(next.androidSnapshot.helperSessionReused, true);
  assert.equal(processes[1]?.exitCode, null);
  assert.equal(spawnArgs.length, 2);
});

test('a command capture leaves another owner helper running after cancellation', async () => {
  const calls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const controller = new AbortController();
  const cancellation = new Error('observation cancelled');
  let cancelCapture = false;
  const provider = createPersistentSnapshotHelperProvider({
    calls,
    spawnArgs,
    processes,
    sessionCommand(command) {
      if (cancelCapture && command.startsWith('snapshot')) controller.abort(cancellation);
      return undefined;
    },
  });
  const options = { helperAdb: provider, helperArtifact };
  await snapshotAndroid(device, { ...options, helperSessionScope: 'daemon-session' });

  cancelCapture = true;
  const capture = snapshotAndroid(device, { ...options, signal: controller.signal });
  await assert.rejects(capture, cancellation);
  cancelCapture = false;
  const next = await snapshotAndroid(device, { ...options, helperSessionScope: 'daemon-session' });

  const forceStopped = calls.some(isAndroidHelperRuntimeForceStop);
  assert.equal(forceStopped, false);
  assert.equal(processes[0]?.exitCode, null);
  assert.equal(spawnArgs.length, 1);
  assert.equal(next.androidSnapshot.helperSessionReused, true);
});

test('a command capture reports unusable content without retiring another owner helper', async () => {
  const calls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls,
    spawnArgs,
    processes,
    sessionXml: (_sessionIndex, captureCount) =>
      captureCount === 1
        ? '<hierarchy><node text="ready" bounds="[0,0][10,10]" /></hierarchy>'
        : androidSystemWindowOnlyXml(),
  });
  const options = { helperAdb: provider, helperArtifact };
  await snapshotAndroid(device, { ...options, helperSessionScope: 'daemon-session' });

  const capture = snapshotAndroid(device, options);
  await assert.rejects(capture, isUnreadableCaptureContentError);

  const forceStopped = calls.some(isAndroidHelperRuntimeForceStop);
  assert.equal(forceStopped, false);
  assert.equal(processes[0]?.exitCode, null);
  assert.equal(spawnArgs.length, 1);
});

test('a failed command capture leaves the helper available to its owner', async () => {
  const calls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const oneShotAttempts: (readonly string[])[] = [];
  let failCapture = false;
  const provider = createPersistentSnapshotHelperProvider({
    calls,
    spawnArgs,
    processes,
    oneShotAttempts,
    sessionCommand(command) {
      if (failCapture && command.startsWith('snapshot')) {
        return {
          ok: 'false',
          errorType: 'java.lang.IllegalStateException',
          errorMessage: 'capture failed',
        };
      }
      return undefined;
    },
  });
  const options = { helperAdb: provider, helperArtifact };
  await snapshotAndroid(device, { ...options, helperSessionScope: 'daemon-session' });

  failCapture = true;
  const capture = snapshotAndroid(device, options);
  await assert.rejects(
    capture,
    (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
  );
  failCapture = false;
  const next = await snapshotAndroid(device, { ...options, helperSessionScope: 'daemon-session' });

  assert.equal(processes[0]?.exitCode, null);
  assert.equal(spawnArgs.length, 1);
  assert.equal(oneShotAttempts.length, 0);
  assert.equal(next.androidSnapshot.helperSessionReused, true);
});

test('a non-owner capture refuses another helper identity without replacing the active helper', async () => {
  const calls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls, spawnArgs, processes });
  const options = { adb: provider.exec, adbProvider: provider, deviceKey: 'android:emulator-5554' };
  await captureAndroidSnapshotWithHelperSession(options);

  const capture = captureAndroidSnapshotWithHelperSession({
    ...options,
    helperSha256: 'different-helper',
    ownsHelperSession: false,
  });
  await assert.rejects(capture, (error: unknown) => {
    return (
      error instanceof AppError &&
      error.details?.reason === 'android-snapshot-helper-ownership-mismatch'
    );
  });

  const next = await captureAndroidSnapshotWithHelperSession(options);
  assert.equal(processes[0]?.exitCode, null);
  assert.equal(spawnArgs.length, 1);
  assert.equal(next?.metadata.sessionReused, true);
});
