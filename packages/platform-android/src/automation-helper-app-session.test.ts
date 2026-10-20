import { afterEach, expect, test } from 'vitest';
import { once } from 'node:events';
import { openAndroidApp } from './app-lifecycle.ts';
import { withAndroidAdbProvider } from './adb-executor.ts';
import { readAndroidFillTargetBeforeMutation } from './fill-verification.ts';
import { resetAndroidSnapshotHelperSessions } from './snapshot-helper-session-lifecycle.ts';
import {
  createPersistentSnapshotHelperProvider,
  type FakeAndroidProcess,
} from './__tests__/snapshot-helper-session.fixtures.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT as artifact } from './__tests__/test-utils/android-snapshot-helper.ts';
import { ANDROID_EMULATOR as device } from './__tests__/test-utils/device-fixtures.ts';
afterEach(resetAndroidSnapshotHelperSessions);

test.each(['advertised', 'unsupported', 'ended', 'non-native-name'] as const)(
  'app open through an %s session uses exactly one launch transport',
  async (mode) => {
    const calls: (readonly string[])[] = [],
      requests: string[] = [],
      processes: FakeAndroidProcess[] = [];
    const pkg = mode === 'non-native-name' ? '_com.example.app' : 'com.example.app';
    const provider = createPersistentSnapshotHelperProvider({
      calls,
      processes,
      spawnArgs: [],
      sessionRequests: requests,
      sessionCommands:
        mode === 'unsupported' ? ['snapshot-immediate'] : ['snapshot-immediate', 'app'],
      sessionCommand: (command) =>
        command.startsWith('app ')
          ? {
              launchOutputBase64: Buffer.from(
                `Status: ok\nActivity: ${pkg}/.MainActivity\n`,
              ).toString('base64'),
            }
          : undefined,
    });
    const exec = provider.exec;
    await withAndroidAdbProvider(
      {
        ...provider,
        snapshotHelperArtifact: artifact,
        exec: async (args, options) => {
          if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start') {
            calls.push(args);
            return {
              stdout: `Status: ok\nActivity: ${pkg}/.MainActivity\n`,
              stderr: '',
              exitCode: 0,
            };
          }
          return await exec(args, options);
        },
      },
      { serial: device.id },
      async () => {
        await readAndroidFillTargetBeforeMutation(device, 10, 10, {
          helperSessionScope: 'daemon-session',
        });
        if (mode === 'ended') {
          const exited = once(processes[0]!, 'close');
          processes[0]!.kill();
          await exited;
        }
        await expect(openAndroidApp(device, ` ${pkg} `)).resolves.toBe(pkg);
      },
    );
    const appRequests = requests.filter((request) => request.startsWith('app '));
    expect(appRequests).toHaveLength(mode === 'advertised' ? 1 : 0);
    expect(
      calls.filter((args) => args[0] === 'shell' && args[1] === 'am' && args[2] === 'start'),
    ).toHaveLength(mode === 'advertised' ? 0 : 1);
    if (mode === 'advertised')
      expect(JSON.parse(Buffer.from(appRequests[0]!.split(' ')[2]!, 'base64').toString())).toEqual({
        kind: 'open',
        packageName: pkg,
      });
    if (mode === 'ended')
      expect(calls.some((args) => args[0] === 'forward' && args[1] === '--remove')).toBe(true);
  },
);
