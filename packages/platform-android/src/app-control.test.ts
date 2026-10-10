import { expect, test } from 'vitest';
import type { AndroidAdbExecutor } from './adb-executor.ts';
import { openAndroidAppWithAdb } from './app-control.ts';

function recordingAdb(): { adb: AndroidAdbExecutor; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    adb: async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

test('openAndroidAppWithAdb launches the activity override as a package-relative component', async () => {
  const { adb, calls } = recordingAdb();
  await openAndroidAppWithAdb(adb, 'com.example.app', { activity: 'MainActivity' });
  expect(calls.at(-1)?.slice(-2)).toEqual(['-n', 'com.example.app/.MainActivity']);
});

test('openAndroidAppWithAdb refuses an activity outside the component grammar before any adb call', async () => {
  const { adb, calls } = recordingAdb();
  for (const activity of ['.Main;id', 'com..example/.Main', '']) {
    await expect(openAndroidAppWithAdb(adb, 'com.example.app', { activity })).rejects.toMatchObject(
      {
        code: 'INVALID_ARGS',
        details: { reason: 'invalid-android-activity-component', activity },
      },
    );
  }
  expect(calls).toEqual([]);
});
