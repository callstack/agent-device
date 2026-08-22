import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { captureAndroidSnapshotWithHelperSession } from '../snapshot-helper-session.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { resolveAndroidSnapshotHelperSessionRequestTimeoutMs } from '../snapshot-helper-session-protocol.ts';
import {
  createSessionProvider,
  type FakeAndroidProcess,
} from './snapshot-helper-session.fixtures.ts';

beforeEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

test('allows a persistent session snapshot to use the helper command budget', async () => {
  const calls: string[][] = [];
  const provider = createSessionProvider({ calls, responseDelayMs: 25 });

  assert.equal(
    resolveAndroidSnapshotHelperSessionRequestTimeoutMs({
      timeoutMs: 10,
      commandTimeoutMs: 4_000,
    }),
    3_010,
  );

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    timeoutMs: 10,
    commandTimeoutMs: 4_000,
  });

  assert.match(output?.xml ?? '', /snapshot 1/);
  assert.equal(output?.metadata.transport, 'persistent-session');
  assert.equal(output?.metadata.sessionReused, false);
});

test('retires a persistent session that exceeds the helper command budget', async () => {
  const calls: string[][] = [];
  const provider = createSessionProvider({ calls, responseDelayMs: 50 });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    timeoutMs: 10,
    commandTimeoutMs: 20,
  });

  assert.equal(output, undefined);
  assert.equal(
    calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

test('cancels a stalled snapshot, retires its helper, and starts the next capture cleanly', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls, processes, stalledSnapshots: 1 });
  const controller = new AbortController();
  const capture = captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error('wait deadline exceeded')), 10);

  await assert.rejects(capture, /wait deadline exceeded/);
  assert.equal(processes[0]?.killed, true);
  assert.equal(
    calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );

  const next = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  assert.match(next?.xml ?? '', /snapshot 1/);
  assert.equal(next?.metadata.sessionReused, false);
  assert.equal(processes.length, 2);
});

test('canceled capture joins canceled external cleanup before returning', async () => {
  const calls: string[][] = [];
  const cleanupAborts: string[][] = [];
  const provider = createSessionProvider({
    calls,
    cleanupAborts,
    stalledSnapshots: 1,
    stalledCleanup: true,
  });
  const controller = new AbortController();
  const capture = captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error('wait deadline exceeded')), 10);

  const outcome = await Promise.race([
    capture.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 750)),
  ]);

  assert.equal(outcome, 'rejected');
  assert.equal(cleanupAborts.length, 2);
});

test('failed capture does not fall back when device runtime retirement is unconfirmed', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({
    calls,
    processes,
    recoveryFailure: true,
    responseMode: 'malformed',
    stalledCleanup: true,
  });

  await assert.rejects(
    captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: provider,
      deviceKey: 'android:emulator-5554',
    }),
    (error: unknown) =>
      (error as { details?: { reason?: string } }).details?.reason ===
      'android_snapshot_helper_retirement_unconfirmed',
  );

  await assert.rejects(
    captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: { exec: provider.exec },
      deviceKey: 'android:emulator-5554',
    }),
    (error: unknown) =>
      (error as { details?: { reason?: string } }).details?.reason ===
      'android_snapshot_helper_retirement_unconfirmed',
  );
  assert.equal(processes.length, 1);
});

test('allows device retirement beyond host-process grace before falling back', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({
    calls,
    processes,
    responseMode: 'ui-automation-timeout',
    forceStopDelayMs: 300,
  });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(output, undefined);
  assert.equal(processes[0]?.killed, true);
});

test('invalidates and falls back from the helper session after a malformed response', async () => {
  const calls: string[][] = [];
  const provider = createSessionProvider({ calls, responseMode: 'malformed' });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(output, undefined);
  assert.equal(
    calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});
