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
  'public Android helpers retain explicit hosts and only their own request overlays',
  async () => {
    const { runAndroidShell, runAndroidExecOut } = await import('./android-adb.ts');
    const { ANDROID_EMULATOR, mkdtempForTestSync } = await import('@agent-device/test-kit');
    const { withCommandHost } = await import('@agent-device/host-kit/command');
    const { writeFileSync, chmodSync, realpathSync } = await import('node:fs');
    const { join } = await import('node:path');
    const bin = mkdtempForTestSync('agent-device-sdk-adb-');
    writeFileSync(
      join(bin, 'adb'),
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),owner:process.env.SDK_OWNER,cwd:process.cwd()}));`,
    );
    chmodSync(join(bin, 'adb'), 0o755);
    const host = (owner: string) => ({ env: { PATH: bin, SDK_OWNER: owner }, cwd: bin });
    const results = await withCommandHost(
      { host: host('foreign'), requestEnv: { SDK_OWNER: 'request' } },
      () =>
        Promise.all([
          runAndroidShell(ANDROID_EMULATOR, ['id'], host('shell')),
          runAndroidExecOut(ANDROID_EMULATOR, ['id'], host('exec')),
        ]),
    );
    for (const [index, command, owner] of [
      [0, 'shell', 'shell'],
      [1, 'exec-out', 'exec'],
    ] as const) {
      assert.deepEqual(JSON.parse(results[index].stdout), {
        args: ['-s', ANDROID_EMULATOR.id, command, 'id'],
        owner,
        cwd: realpathSync(bin),
      });
    }
    const sharedHost = host('base');
    const scoped = await withCommandHost(
      { host: sharedHost, requestEnv: { SDK_OWNER: 'overlay' } },
      () => runAndroidShell(ANDROID_EMULATOR, ['id'], sharedHost),
    );
    assert.deepEqual(JSON.parse(scoped.stdout), {
      args: ['-s', ANDROID_EMULATOR.id, 'shell', 'id'],
      owner: 'overlay',
      cwd: realpathSync(bin),
    });
  },
);
