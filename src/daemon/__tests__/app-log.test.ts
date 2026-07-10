import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
import { withAppleToolProvider } from '../../platforms/apple/core/tool-provider.ts';
import type { ExecResult } from '../../utils/exec.ts';
import { runAppLogDoctor, rotateAppLogIfNeeded } from '../app-log.ts';
import { assertAndroidPackageArgSafe } from '../app-log-android.ts';
import {
  buildAppleLogPredicate,
  buildIosDeviceConsoleLaunchArgs,
  buildIosSimulatorLogStreamArgs,
  startIosDeviceAppLog,
} from '../app-log-ios.ts';
import { APP_LOG_PID_FILENAME, cleanupStaleAppLogProcesses } from '../app-log-process.ts';

const IOS_DEVICE_ID = '00008150-0000AAAA';
const IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: IOS_DEVICE_ID,
  name: 'iPhone',
  kind: 'device',
};
const IOS_DEVICE_HELP_WITHOUT_CONSOLE_CAPTURE =
  'USAGE: devicectl device [--verbose] [--quiet] <subcommand>\n\nSUBCOMMANDS:\n  info\n  process\n';
const IOS_DEVICE_CONSOLE_CAPTURE_HELP = `USAGE: devicectl device process launch [<options>] --device <uuid|ecid|serial_number|udid|name|dns_name> <bundle-identifier-or-path>

COMMAND OPTIONS:
  --console               Attaches the application to the console and waits for it to exit.
  --terminate-existing    Terminates any already-running instances of the app prior to launch.`;

type FakeDevicectlRun = (args: string[]) => Promise<ExecResult>;

async function withFakeDevicectl<T>(
  run: FakeDevicectlRun,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: string[][] }> {
  const calls: string[][] = [];
  const result = await withAppleToolProvider(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      devicectl: {
        run: async (args) => {
          calls.push(args);
          return await run(args);
        },
      },
      whichCommand: async () => false,
    },
    fn,
  );
  return { result, calls };
}

function makeAppLogWriteStream(prefix: string): fs.WriteStream {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.createWriteStream(path.join(root, 'app.log'), { flags: 'a' });
}

test('buildAppleLogPredicate includes bundle-aware filters', () => {
  const predicate = buildAppleLogPredicate('com.example.app');
  assert.match(predicate, /subsystem == "com\.example\.app"/);
  assert.match(predicate, /subsystem CONTAINS "com\.example\.app"/);
  assert.match(predicate, /processImagePath ENDSWITH\[c\] "\/com\.example\.app"/);
  assert.match(predicate, /senderImagePath ENDSWITH\[c\] "\/com\.example\.app"/);
  assert.doesNotMatch(predicate, /eventMessage CONTAINS\[c\] "com\.example\.app"/);
});

test('buildAppleLogPredicate includes executable-aware filters when available', () => {
  const predicate = buildAppleLogPredicate('com.example.app', 'ExampleExec');
  assert.match(predicate, /process == "ExampleExec"/);
  assert.match(predicate, /processImagePath ENDSWITH\[c\] "\/ExampleExec"/);
  assert.match(predicate, /processImagePath CONTAINS\[c\] "\/ExampleExec\.app\/"/);
});

test('assertAndroidPackageArgSafe rejects unsafe values', () => {
  assert.doesNotThrow(() => assertAndroidPackageArgSafe('com.example.app'));
  assert.throws(
    () => assertAndroidPackageArgSafe('com.example.app;rm -rf /'),
    /Invalid Android package/,
  );
});

test('rotateAppLogIfNeeded rotates and truncates oldest by configured max files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-app-log-rotate-'));
  const outPath = path.join(root, 'app.log');
  fs.writeFileSync(outPath, 'a'.repeat(20));
  fs.writeFileSync(`${outPath}.1`, 'old1');
  fs.writeFileSync(`${outPath}.2`, 'old2');

  rotateAppLogIfNeeded(outPath, { maxBytes: 10, maxRotatedFiles: 2 });

  assert.equal(fs.existsSync(outPath), false);
  assert.equal(fs.readFileSync(`${outPath}.1`, 'utf8').length, 20);
  assert.equal(fs.readFileSync(`${outPath}.2`, 'utf8'), 'old1');
});

test('cleanupStaleAppLogProcesses removes pid files even when pid is stale', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-app-log-clean-'));
  const sessionDir = path.join(root, 'default');
  fs.mkdirSync(sessionDir, { recursive: true });
  const pidPath = path.join(sessionDir, APP_LOG_PID_FILENAME);
  fs.writeFileSync(pidPath, '999999\n');

  cleanupStaleAppLogProcesses(root);

  assert.equal(fs.existsSync(pidPath), false);
});

test('buildIosDeviceConsoleLaunchArgs builds expected devicectl command args', () => {
  assert.deepEqual(buildIosDeviceConsoleLaunchArgs(IOS_DEVICE_ID, 'com.example.app'), [
    'devicectl',
    'device',
    'process',
    'launch',
    '--device',
    IOS_DEVICE_ID,
    '--console',
    '--terminate-existing',
    'com.example.app',
  ]);
});

test('startIosDeviceAppLog reports unsupported devicectl console capture before spawning', async () => {
  const stream = makeAppLogWriteStream('agent-device-ios-device-log-');
  const { calls } = await withFakeDevicectl(
    async () => ({
      stdout: IOS_DEVICE_HELP_WITHOUT_CONSOLE_CAPTURE,
      stderr: '',
      exitCode: 0,
    }),
    async () => {
      await assert.rejects(
        async () => await startIosDeviceAppLog(IOS_DEVICE_ID, 'com.example.app', stream, []),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'UNSUPPORTED_OPERATION');
          assert.match(error.message, /iOS physical-device app console capture is not supported/);
          assert.equal(error.details?.backend, 'ios-device');
          return true;
        },
      );
    },
  );

  await finished(stream).catch(() => {});
  assert.deepEqual(calls, [['device', 'process', 'launch', '--help']]);
});

test('startIosDeviceAppLog reports retryable failure when devicectl support probe fails', async () => {
  const stream = makeAppLogWriteStream('agent-device-ios-device-log-timeout-');

  await withFakeDevicectl(
    async () => {
      throw new Error('xcrun timed out after 5000ms');
    },
    async () => {
      await assert.rejects(
        async () => await startIosDeviceAppLog(IOS_DEVICE_ID, 'com.example.app', stream, []),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /Could not verify iOS physical-device app console capture/);
          assert.equal(error.details?.stderr, 'xcrun timed out after 5000ms');
          return true;
        },
      );
    },
  );

  await finished(stream).catch(() => {});
});

test('runAppLogDoctor reports supported iOS physical-device console capture', async () => {
  const { result, calls } = await withFakeDevicectl(
    async (args) => {
      if (args.join(' ') === '--version') {
        return { stdout: '506.6\n', stderr: '', exitCode: 0 };
      }
      return {
        stdout: IOS_DEVICE_CONSOLE_CAPTURE_HELP,
        stderr: '',
        exitCode: 0,
      };
    },
    async () => await runAppLogDoctor(IOS_DEVICE, 'com.example.app'),
  );

  assert.deepEqual(calls, [['--version'], ['device', 'process', 'launch', '--help']]);
  assert.equal(result.checks.devicectlAvailable, true);
  assert.equal(result.checks.devicectlConsoleCapture, true);
  assert.equal(result.notes.length, 0);
});

test('startIosDeviceAppLog marks clean devicectl console exit as ended', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-ios-device-console-'));
  const fakeBinDir = path.join(root, 'bin');
  fs.mkdirSync(fakeBinDir);
  const fakeXcrun = path.join(fakeBinDir, 'xcrun');
  fs.writeFileSync(fakeXcrun, '#!/bin/sh\nprintf "app output\\n"\nexit 0\n');
  fs.chmodSync(fakeXcrun, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${previousPath ?? ''}`;
  const stream = fs.createWriteStream(path.join(root, 'app.log'), { flags: 'a' });

  try {
    await withFakeDevicectl(
      async () => ({ stdout: IOS_DEVICE_CONSOLE_CAPTURE_HELP, stderr: '', exitCode: 0 }),
      async () => {
        const appLog = await startIosDeviceAppLog(IOS_DEVICE_ID, 'com.example.app', stream, []);
        assert.equal(appLog.getState(), 'active');
        assert.equal((await appLog.wait).exitCode, 0);
        assert.equal(appLog.getState(), 'ended');
      },
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await finished(stream).catch(() => {});
  }
});

test('buildIosSimulatorLogStreamArgs streams logs inside the simulator at info level', () => {
  assert.deepEqual(
    buildIosSimulatorLogStreamArgs({
      deviceId: 'sim-1',
      appBundleId: 'com.example.app',
      executableName: 'ExampleExec',
    }),
    [
      'simctl',
      'spawn',
      'sim-1',
      'log',
      'stream',
      '--style',
      'compact',
      '--level',
      'info',
      '--predicate',
      buildAppleLogPredicate('com.example.app', 'ExampleExec'),
    ],
  );
});

test('buildIosSimulatorLogStreamArgs respects simulator device set scoping', () => {
  assert.deepEqual(
    buildIosSimulatorLogStreamArgs({
      deviceId: 'sim-1',
      appBundleId: 'com.example.app',
      simulatorSetPath: '/tmp/tenant-a/simulators',
    }),
    [
      'simctl',
      '--set',
      '/tmp/tenant-a/simulators',
      'spawn',
      'sim-1',
      'log',
      'stream',
      '--style',
      'compact',
      '--level',
      'info',
      '--predicate',
      buildAppleLogPredicate('com.example.app'),
    ],
  );
});

test('cleanupStaleAppLogProcesses removes legacy plain pid files safely', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-app-log-clean-legacy-'));
  const sessionDir = path.join(root, 'default');
  fs.mkdirSync(sessionDir, { recursive: true });
  const pidPath = path.join(sessionDir, APP_LOG_PID_FILENAME);
  fs.writeFileSync(pidPath, '1\n');

  cleanupStaleAppLogProcesses(root);

  assert.equal(fs.existsSync(pidPath), false);
});

test('runAppLogDoctor returns note when app bundle is missing', async () => {
  const result = await runAppLogDoctor({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
  });
  assert.equal(Array.isArray(result.notes), true);
  assert.ok(result.notes.some((note) => note.includes('Run open <app> first')));
});
