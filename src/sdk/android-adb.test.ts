import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AndroidAdbExecutor } from '@agent-device/platform-android/mechanics';
import { getAndroidAppStateWithAdb } from './android-adb.ts';

test('getAndroidAppStateWithAdb parses focus output from failed commands', async () => {
  const calls: (readonly string[])[] = [];
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
  const calls: (readonly string[])[] = [];
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

test.skipIf(process.platform === 'win32')(
  'standalone public Android shell helpers establish their process host before dispatch',
  async () => {
    const { runAndroidShell, runAndroidExecOut } = await import('./android-adb.ts');
    const { ANDROID_EMULATOR, mkdtempForTestSync } = await import('@agent-device/test-kit');
    const { writeFileSync, chmodSync } = await import('node:fs');
    const { join } = await import('node:path');
    const bin = mkdtempForTestSync('agent-device-sdk-adb-');
    const adbPath = join(bin, 'adb');
    writeFileSync(
      adbPath,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));`,
    );
    chmodSync(adbPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const shell = await runAndroidShell(ANDROID_EMULATOR, ['id']);
      const execOut = await runAndroidExecOut(ANDROID_EMULATOR, ['id']);
      assert.deepEqual(JSON.parse(shell.stdout), ['-s', ANDROID_EMULATOR.id, 'shell', 'id']);
      assert.deepEqual(JSON.parse(execOut.stdout), ['-s', ANDROID_EMULATOR.id, 'exec-out', 'id']);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
);
