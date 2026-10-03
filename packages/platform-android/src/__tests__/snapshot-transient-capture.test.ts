import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../adb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adb.ts')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

import { isUnreadableCaptureContentError } from '@agent-device/contracts/android-snapshot-quality';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppError } from '@agent-device/kernel/errors';
import { snapshotAndroid } from '../snapshot.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import type { AndroidAdbExecutor } from '../snapshot-helper.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import {
  androidSystemWindowOnlyXml,
  createPersistentSnapshotHelperProvider,
  isAndroidHelperRuntimeForceStop as isHelperRuntimeReset,
  type FakeAndroidProcess,
} from './snapshot-helper-session.fixtures.ts';

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

function openSettleWindow(): { settleBy: number } {
  return { settleBy: Date.now() + 60_000 };
}

function isHelperVersionProbe(args: readonly string[]): boolean {
  return args.includes('--show-versioncode');
}

test('a transient capture releases a helper session it had to start', async () => {
  const adbCalls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    processes,
  });

  await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact,
    transient: openSettleWindow(),
  });

  assert.equal(spawnArgs.length, 1);
  assert.equal(processes[0]?.exitCode, 0);
  assert.equal(
    adbCalls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

test('a transient capture leaves a warm daemon-session helper running', async () => {
  const adbCalls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    processes,
  });

  await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact,
    helperSessionScope: 'daemon-session',
  });
  const borrowed = await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact,
    transient: openSettleWindow(),
  });

  assert.equal(borrowed.androidSnapshot.helperSessionReused, true);
  assert.equal(spawnArgs.length, 1);
  assert.equal(processes[0]?.exitCode, null);
  assert.equal(
    adbCalls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    false,
  );
});

test('a transient capture reports its content verdict without retiring the warm helper', async () => {
  const adbCalls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    processes,
    sessionXml: (_sessionIndex, snapshotCount) =>
      snapshotCount === 1
        ? '<hierarchy><node text="warm helper" bounds="[0,0][10,10]" /></hierarchy>'
        : androidSystemWindowOnlyXml(),
  });
  await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact,
    helperSessionScope: 'daemon-session',
  });

  await assert.rejects(
    snapshotAndroid(device, { helperAdb: provider, helperArtifact, transient: openSettleWindow() }),
    (error: unknown) => isUnreadableCaptureContentError(error),
  );

  assert.equal(processes[0]?.exitCode, null, 'the session helper is still running');
  assert.equal(adbCalls.some(isHelperRuntimeReset), false);
  assert.equal(spawnArgs.length, 1);
});

test('a settle window that passes during the helper start never cancels the start', async () => {
  const adbCalls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    processes,
    sessionXml: () => androidSystemWindowOnlyXml(),
    sessionReadyDelayMs: 150,
  });

  await assert.rejects(
    snapshotAndroid(device, {
      helperAdb: provider,
      helperArtifact,
      transient: { settleBy: Date.now() + 30 },
    }),
    (error: unknown) =>
      isUnreadableCaptureContentError(error) && (error as AppError).details?.attempts === 1,
  );

  assert.equal(spawnArgs.length, 1);
  assert.equal(processes[0]?.killed, false, 'the started helper was not signalled');
  assert.equal(processes[0]?.exitCode, 0, 'the started helper quit on its own');
  assert.equal(adbCalls.some(isHelperRuntimeReset), false);
});

test('a settle window that passes during a warm session capture leaves the session running', async () => {
  const adbCalls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    processes,
    sessionXml: (_sessionIndex, snapshotCount) =>
      snapshotCount === 1
        ? '<hierarchy><node text="warm helper" bounds="[0,0][10,10]" /></hierarchy>'
        : androidSystemWindowOnlyXml(),
    captureResponseDelayMs: (snapshotCount) => (snapshotCount === 1 ? 0 : 150),
  });
  await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact,
    helperSessionScope: 'daemon-session',
  });

  await assert.rejects(
    snapshotAndroid(device, {
      helperAdb: provider,
      helperArtifact,
      transient: { settleBy: Date.now() + 30 },
    }),
    (error: unknown) =>
      isUnreadableCaptureContentError(error) && (error as AppError).details?.attempts === 1,
  );

  assert.equal(spawnArgs.length, 1);
  assert.equal(processes[0]?.killed, false);
  assert.equal(processes[0]?.exitCode, null, 'the session helper is still running');
  assert.equal(adbCalls.some(isHelperRuntimeReset), false);
});

test('a transient capture on a device without the current helper installs and resets nothing', async () => {
  const adbCalls: (readonly string[])[] = [];
  const helperAdb: AndroidAdbExecutor = async (args) => {
    adbCalls.push(args);
    if (isHelperVersionProbe(args)) return { exitCode: 1, stdout: '', stderr: 'not found' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    snapshotAndroid(device, { helperAdb, helperArtifact, transient: openSettleWindow() }),
    (error: unknown) =>
      (error as AppError).details?.reason === 'android-snapshot-helper-not-current',
  );

  assert.equal(
    adbCalls.some((args) => args.includes('install') || args.includes('instrument')),
    false,
  );
  assert.equal(adbCalls.some(isHelperRuntimeReset), false, 'a refusal is not a helper failure');
});
