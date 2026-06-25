import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { withMockedAdb } from '../../../src/__tests__/test-utils/mocked-binaries.ts';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';
import {
  assertCommandCall,
  assertRecordingStarted,
  assertRecordingStopped,
  assertRpcOk,
} from './assertions.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import {
  restoreEnv,
  createProviderScenarioHarness,
  likelyPlayableMp4Container,
  withProviderScenarioTempDir,
} from './harness.ts';

test('Provider-backed integration Android recording flow uses scripted ADB provider pull capability', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-',
    async (tmpDir) => {
      const recordingPath = path.join(tmpDir, 'recording.mp4');
      const adbCalls: string[][] = [];
      const pullCalls: Array<{ remotePath: string; localPath: string }> = [];
      const adbProvider: AndroidAdbProvider = {
        exec: async (args) => {
          adbCalls.push([...args]);
          return androidAdbResult(args);
        },
        pull: async (remotePath, localPath) => {
          pullCalls.push({ remotePath, localPath });
          fs.writeFileSync(localPath, likelyPlayableMp4Container());
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const daemon = await createProviderScenarioHarness({
        androidAdbProvider: () => adbProvider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      });

      const previousPath = process.env.PATH;
      const previousSwiftCacheDir = process.env.AGENT_DEVICE_SWIFT_CACHE_DIR;
      process.env.PATH = tmpDir;
      process.env.AGENT_DEVICE_SWIFT_CACHE_DIR = path.join(tmpDir, 'swift-cache');

      try {
        const open = await daemon.callCommand('open', ['settings'], {
          platform: 'android',
          serial: PROVIDER_SCENARIO_ANDROID.id,
        });
        assertRpcOk(open);

        const recordStart = await daemon.callCommand('record', ['start', recordingPath], {
          hideTouches: true,
          screenshotMaxSize: 1344,
          quality: 'high',
        });
        assertRecordingStarted(recordStart, { showTouches: false });

        const recordStop = await daemon.callCommand('record', ['stop']);
        assertRecordingStopped(recordStop, recordingPath, { showTouches: false });
        assert.equal(fs.existsSync(recordingPath), true);

        assertCommandCall(adbCalls, ['shell', 'wm', 'size']);
        assert.ok(
          adbCalls.some((args) =>
            /^shell screenrecord --size 756x1344 --bit-rate 20000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
              args.join(' '),
            ),
          ),
          JSON.stringify(adbCalls),
        );
        assertCommandCall(adbCalls, ['shell', 'kill', '-2', '4321']);
        assert.equal(pullCalls.length, 1);
        assert.match(pullCalls[0]?.remotePath ?? '', /^\/sdcard\/agent-device-recording-\d+\.mp4$/);
        assert.equal(pullCalls[0]?.localPath, recordingPath);
        assert.ok(adbCalls.some((args) => args[0] === 'shell' && args[1] === 'rm'));
        assert.equal(
          adbCalls.some((args) => args[0] === 'pull'),
          false,
        );
      } finally {
        await daemon.close();
        restoreEnv('PATH', previousPath);
        restoreEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', previousSwiftCacheDir);
      }
    },
  );
});

test('Provider-backed integration Android record start without a session scopes default-device providers', async () => {
  await withMockedAdb(
    'agent-device-provider-scenario-android-sessionless-record-',
    async (logPath) => {
      await withProviderScenarioTempDir(
        'agent-device-provider-scenario-android-sessionless-record-',
        async (tmpDir) => {
          const recordingPath = path.join(tmpDir, 'sessionless-recording.mp4');
          const adbCalls: string[][] = [];
          const adbProvider: AndroidAdbProvider = {
            exec: async (args) => {
              adbCalls.push([...args]);
              return androidAdbResult(args);
            },
          };
          const daemon = await createProviderScenarioHarness({
            androidAdbProvider: () => adbProvider,
            deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
          });

          try {
            const recordStart = await daemon.callCommand('record', ['start', recordingPath]);

            assertRecordingStarted(recordStart, { showTouches: true });
            assert.ok(
              adbCalls.some((args) => isAndroidDefaultScreenrecordStartCommand(args.join(' '))),
              JSON.stringify(adbCalls),
            );
            assert.equal(
              adbCalls.some((args) => args.join(' ') === 'shell wm size'),
              false,
            );
            assert.deepEqual(readLoggedArgs(logPath), []);
          } finally {
            await daemon.close();
          }
        },
      );
    },
  );
});

function androidAdbResult(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBuffer?: Buffer;
} {
  const command = args.join(' ');
  if (command === 'shell getprop sys.boot_completed') {
    return { stdout: '1\n', stderr: '', exitCode: 0 };
  }
  if (command === 'shell wm size') {
    return {
      stdout: 'Physical size: 1440x2560\nOverride size: 1080x1920\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (
    /^shell screenrecord --size 756x1344 --bit-rate 20000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
      command,
    )
  ) {
    return { stdout: '4321\n', stderr: '', exitCode: 0 };
  }
  if (isAndroidScreenrecordStartCommand(command)) {
    return { stdout: '4321\n', stderr: '', exitCode: 0 };
  }
  if (/^shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)) {
    return { stdout: '2048\n', stderr: '', exitCode: 0 };
  }
  if (command === 'shell ps -o pid= -p 4321') {
    return { stdout: '', stderr: '', exitCode: 1 };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

function isAndroidScreenrecordStartCommand(command: string): boolean {
  return /^shell screenrecord (?:--size 756x1344 )?--bit-rate (?:8000000|20000000) \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
    command,
  );
}

function isAndroidDefaultScreenrecordStartCommand(command: string): boolean {
  return /^shell screenrecord --bit-rate 8000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
    command,
  );
}

function readLoggedArgs(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
