import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { AndroidAdbExecutor } from '../adb-executor.ts';

const { stopSession } = vi.hoisted(() => ({ stopSession: vi.fn() }));

vi.mock('../snapshot-helper-session.ts', () => ({
  stopAndroidSnapshotHelperSession: stopSession,
}));

vi.mock('../adb.ts', () => ({ sleep: vi.fn(async () => {}) }));

import { retireAndroidSnapshotHelperAfterContentFailure } from '../snapshot-helper-runtime.ts';

beforeEach(() => {
  stopSession.mockReset();
});

test('content failure retirement does not layer a second reset over a persistent session stop', async () => {
  stopSession.mockResolvedValueOnce(true);
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  await retireAndroidSnapshotHelperAfterContentFailure({
    adb,
    deviceKey: 'android:emulator-5554',
    packageName: 'com.example.helper',
    cause: 'content-poor-app-window',
  });

  assert.equal(stopSession.mock.calls.length, 1);
  assert.equal(calls.length, 0);
});

test('content failure resets a one-shot helper when no persistent session exists', async () => {
  stopSession.mockResolvedValueOnce(false);
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  await retireAndroidSnapshotHelperAfterContentFailure({
    adb,
    deviceKey: 'android:emulator-5554',
    packageName: 'com.example.helper',
    cause: 'empty-helper-output',
  });

  assert.deepEqual(calls[0], ['shell', 'am', 'force-stop', 'com.example.helper']);
});
