import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AndroidAdbExecutor } from '../platforms/android/adb-executor.ts';
import { getAndroidAppStateWithAdb } from './android-adb.ts';

test('getAndroidAppStateWithAdb parses focus output from failed commands', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    return {
      exitCode: 1,
      stdout: 'mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}\n',
      stderr: 'dumpsys warning',
    };
  };

  const state = await getAndroidAppStateWithAdb(adb);

  assert.deepEqual(state, { package: 'com.example.app', activity: '.MainActivity' });
  assert.deepEqual(calls, [['shell', 'dumpsys', 'window', 'windows']]);
});

test('getAndroidAppStateWithAdb falls back to activity focus and settles empty', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const state = await getAndroidAppStateWithAdb(adb);

  assert.deepEqual(state, {});
  assert.deepEqual(calls, [
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'dumpsys', 'window'],
    ['shell', 'dumpsys', 'activity', 'activities'],
    ['shell', 'dumpsys', 'activity'],
  ]);
});
