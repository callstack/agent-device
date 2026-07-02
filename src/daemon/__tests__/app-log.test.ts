import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { AppError } from '../../kernel/errors.ts';
import { withAppleToolProvider } from '../../platforms/apple/core/tool-provider.ts';
import {
  APP_LOG_PID_FILENAME,
  assertAndroidPackageArgSafe,
  buildAppleLogPredicate,
  buildIosDeviceLogStreamArgs,
  buildIosSimulatorLogStreamArgs,
  cleanupStaleAppLogProcesses,
  runAppLogDoctor,
  rotateAppLogIfNeeded,
} from '../app-log.ts';
import { startIosDeviceAppLog } from '../app-log-ios.ts';

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

test('buildIosDeviceLogStreamArgs builds expected devicectl command args', () => {
  assert.deepEqual(buildIosDeviceLogStreamArgs('00008150-0000AAAA'), [
    'devicectl',
    'device',
    'log',
    'stream',
    '--device',
    '00008150-0000AAAA',
  ]);
});

test('startIosDeviceAppLog reports unsupported devicectl log stream before spawning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-ios-device-log-'));
  const stream = fs.createWriteStream(path.join(root, 'app.log'), { flags: 'a' });
  const devicectlCalls: string[][] = [];

  await withAppleToolProvider(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      devicectl: {
        run: async (args) => {
          devicectlCalls.push(args);
          return {
            stdout:
              'USAGE: devicectl device [--verbose] [--quiet] <subcommand>\n\nSUBCOMMANDS:\n  info\n  process\n',
            stderr: '',
            exitCode: 0,
          };
        },
      },
      whichCommand: async () => false,
    },
    async () => {
      await assert.rejects(
        async () => await startIosDeviceAppLog('00008150-0000AAAA', stream, []),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'UNSUPPORTED_OPERATION');
          assert.match(error.message, /iOS physical-device app log streaming is not supported/);
          assert.equal(error.details?.backend, 'ios-device');
          return true;
        },
      );
    },
  );

  await finished(stream).catch(() => {});
  assert.deepEqual(devicectlCalls, [['device', 'log', 'stream', '--help']]);
});

test('startIosDeviceAppLog reports unsupported when devicectl support probe fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-ios-device-log-timeout-'));
  const stream = fs.createWriteStream(path.join(root, 'app.log'), { flags: 'a' });

  await withAppleToolProvider(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      devicectl: {
        run: async () => {
          throw new Error('xcrun timed out after 5000ms');
        },
      },
      whichCommand: async () => false,
    },
    async () => {
      await assert.rejects(
        async () => await startIosDeviceAppLog('00008150-0000AAAA', stream, []),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'UNSUPPORTED_OPERATION');
          assert.match(error.message, /iOS physical-device app log streaming is not supported/);
          assert.equal(error.details?.stderr, 'xcrun timed out after 5000ms');
          return true;
        },
      );
    },
  );

  await finished(stream).catch(() => {});
});

test('runAppLogDoctor reports unsupported iOS physical-device log stream', async () => {
  const devicectlCalls: string[][] = [];
  const result = await withAppleToolProvider(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      devicectl: {
        run: async (args) => {
          devicectlCalls.push(args);
          if (args.join(' ') === '--version') {
            return { stdout: '506.6\n', stderr: '', exitCode: 0 };
          }
          return {
            stdout:
              'USAGE: devicectl device [--verbose] [--quiet] <subcommand>\n\nSUBCOMMANDS:\n  info\n  process\n',
            stderr: '',
            exitCode: 0,
          };
        },
      },
      whichCommand: async () => false,
    },
    async () =>
      await runAppLogDoctor(
        {
          platform: 'apple',
          appleOs: 'ios',
          id: '00008150-0000AAAA',
          name: 'iPhone',
          kind: 'device',
        },
        'com.example.app',
      ),
  );

  assert.deepEqual(devicectlCalls, [['--version'], ['device', 'log', 'stream', '--help']]);
  assert.equal(result.checks.devicectlAvailable, true);
  assert.equal(result.checks.devicectlDeviceLogStream, false);
  assert.ok(result.notes.some((note) => note.includes('does not expose')));
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
