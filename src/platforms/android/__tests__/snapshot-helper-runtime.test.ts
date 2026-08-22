import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { AndroidAdbExecutor } from '../adb-executor.ts';

const { stopSession } = vi.hoisted(() => ({ stopSession: vi.fn() }));

vi.mock('../snapshot-helper-session-lifecycle.ts', () => ({
  stopAndroidSnapshotHelperSession: stopSession,
}));

vi.mock('../adb.ts', () => ({ sleep: vi.fn(async () => {}) }));

import { retireAndroidSnapshotHelperAfterContentFailure } from '../snapshot-helper-runtime.ts';

beforeEach(() => {
  stopSession.mockReset();
});

test('content failure retirement makes the session stop reset the runtime instead of layering a second one', async () => {
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
  // The session stop only force-stops the runtime when it has to. Recovery cannot read a clean quit
  // as a reason to leave a suspect helper running, so it states that requirement instead of issuing
  // a second `am force-stop` of its own.
  assert.equal(stopSession.mock.calls[0]?.[1]?.resetRuntime, true);
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
