import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'vitest';
import {
  captureAndroidSnapshotWithHelper,
  parseAndroidSnapshotHelperOutput,
} from '../snapshot-helper-capture.ts';
import {
  ensureAndroidSnapshotHelper,
  forgetAndroidSnapshotHelperInstall,
  resetAndroidSnapshotHelperInstallCache,
} from '../snapshot-helper-install.ts';
import { parseAndroidSnapshotHelperManifest } from '../snapshot-helper-artifact.ts';
import { verifyAndroidHelperApkChecksum } from '../helper-package-install.ts';
import type {
  AndroidAdbExecutor,
  AndroidSnapshotHelperManifest,
} from '../snapshot-helper-types.ts';
import type { AndroidAdbProvider } from '../adb-executor.ts';

const manifest: AndroidSnapshotHelperManifest = {
  name: 'android-snapshot-helper',
  version: '0.13.3',
  apkUrl: null,
  sha256: 'a'.repeat(64),
  packageName: 'com.callstack.agentdevice.snapshothelper',
  versionCode: 13003,
  instrumentationRunner: 'com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation',
  minSdk: 23,
  targetSdk: 36,
  outputFormat: 'uiautomator-xml',
  statusProtocol: 'android-snapshot-helper-v1',
  installArgs: ['install', '-r', '-t'],
};

beforeEach(() => {
  resetAndroidSnapshotHelperInstallCache();
});

test('parseAndroidSnapshotHelperOutput reconstructs XML chunks and metadata', () => {
  const xml = '<?xml version="1.0"?><hierarchy><node text="first&#10;second" /></hierarchy>';
  const output = helperOutput({
    chunks: ['<?xml version="1.0"?><hierarchy>', '<node text="first&#10;second" /></hierarchy>'],
    result: {
      ok: 'true',
      helperApiVersion: '1',
      outputFormat: 'uiautomator-xml',
      waitForIdleTimeoutMs: '25',
      waitForIdleQuietMs: '10',
      timeoutMs: '8000',
      maxDepth: '128',
      maxNodes: '5000',
      rootPresent: 'true',
      captureMode: 'interactive-windows',
      windowCount: '2',
      nodeCount: '1',
      truncated: 'false',
      elapsedMs: '42',
    },
  });

  const parsed = parseAndroidSnapshotHelperOutput(output);

  assert.equal(parsed.xml, xml);
  assert.deepEqual(parsed.metadata, {
    helperApiVersion: '1',
    outputFormat: 'uiautomator-xml',
    waitForIdleTimeoutMs: 25,
    waitForIdleQuietMs: 10,
    timeoutMs: 8000,
    maxDepth: 128,
    maxNodes: 5000,
    rootPresent: true,
    captureMode: 'interactive-windows',
    windowCount: 2,
    nodeCount: 1,
    truncated: false,
    elapsedMs: 42,
    transport: 'instrumentation',
  });
});

test('parseAndroidSnapshotHelperOutput decodes UTF-8 across byte chunk boundaries', () => {
  const xml = '<hierarchy><node text="Save 👍" /></hierarchy>';
  const bytes = Buffer.from(xml, 'utf8');
  const split = bytes.indexOf(0xf0) + 2;
  const output = [
    statusRecord({
      chunkIndex: '0',
      chunkCount: '2',
      payloadBase64: bytes.subarray(0, split).toString('base64'),
    }),
    statusRecord({
      chunkIndex: '1',
      chunkCount: '2',
      payloadBase64: bytes.subarray(split).toString('base64'),
    }),
    resultRecord({ ok: 'true', outputFormat: 'uiautomator-xml' }),
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');

  const parsed = parseAndroidSnapshotHelperOutput(output);

  assert.equal(parsed.xml, xml);
});

test('parseAndroidSnapshotHelperOutput rejects incomplete chunks', () => {
  const output = [
    statusRecord({ chunkIndex: '0', chunkCount: '2', payloadBase64: encodeChunk('<hierarchy>') }),
    resultRecord({ ok: 'true', outputFormat: 'uiautomator-xml' }),
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');

  assert.throws(() => parseAndroidSnapshotHelperOutput(output), {
    message: 'Android snapshot helper returned incomplete XML chunks',
  });
});

test('parseAndroidSnapshotHelperOutput treats empty chunk payloads as present', () => {
  const output = [
    statusRecord({ chunkIndex: '0', chunkCount: '1', payloadBase64: '' }),
    resultRecord({ ok: 'true', outputFormat: 'uiautomator-xml' }),
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');

  assert.throws(() => parseAndroidSnapshotHelperOutput(output), {
    message: 'Android snapshot helper output did not contain XML',
  });
});

test('parseAndroidSnapshotHelperOutput rejects duplicate chunks', () => {
  const output = [
    statusRecord({ chunkIndex: '0', chunkCount: '2', payloadBase64: encodeChunk('<hierarchy>') }),
    statusRecord({
      chunkIndex: '0',
      chunkCount: '2',
      payloadBase64: encodeChunk('</hierarchy>'),
    }),
    resultRecord({ ok: 'true', outputFormat: 'uiautomator-xml' }),
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');

  assert.throws(() => parseAndroidSnapshotHelperOutput(output), {
    message: 'Android snapshot helper returned duplicate XML chunks',
  });
});

test('parseAndroidSnapshotHelperOutput falls back to error type for null helper messages', () => {
  const output = [
    statusRecord({ chunkIndex: '0', chunkCount: '1', payloadBase64: encodeChunk('<hierarchy />') }),
    resultRecord({
      ok: 'false',
      outputFormat: 'uiautomator-xml',
      errorType: 'java.lang.IllegalStateException',
      message: 'null',
    }),
    'INSTRUMENTATION_CODE: 1',
  ].join('\n');

  assert.throws(() => parseAndroidSnapshotHelperOutput(output), {
    message: 'java.lang.IllegalStateException',
  });
});

test('ensureAndroidSnapshotHelper installs when missing and skips a newer version', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-helper-install-'));
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const localManifest = {
    ...manifest,
    sha256: sha256Text('helper-apk'),
  };
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args.includes('--show-versioncode')) {
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const installed = await ensureAndroidSnapshotHelper({
    adb,
    artifact: { apkPath, manifest: localManifest },
  });

  assert.equal(installed.installed, true);
  assert.equal(installed.reason, 'missing');
  assert.deepEqual(calls[1], ['install', '-r', '-t', apkPath]);

  const skipped = await ensureAndroidSnapshotHelper({
    adb: async () => ({
      exitCode: 0,
      stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
      stderr: '',
    }),
    artifact: { apkPath, manifest: localManifest },
  });

  assert.equal(skipped.installed, false);
  assert.equal(skipped.reason, 'current');
});

test('ensureAndroidSnapshotHelper replaces same-version helper when APK bytes differ', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-helper-identity-'));
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'new-helper-apk');
  const localManifest = {
    ...manifest,
    sha256: sha256Text('new-helper-apk'),
  };
  const installs: string[] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: `package:${localManifest.packageName} versionCode:${localManifest.versionCode}`,
        stderr: '',
      };
    }
    if (args[0] === 'shell' && args[1] === 'pm' && args[2] === 'path') {
      return { exitCode: 0, stdout: 'package:/data/app/helper/base.apk\n', stderr: '' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };

  const result = await ensureAndroidSnapshotHelper({
    adb,
    adbProvider: {
      exec: adb,
      pull: async (_remotePath, localPath) => {
        await fs.writeFile(localPath, 'old-helper-apk');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      install: async (pathToInstall) => {
        installs.push(pathToInstall);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    artifact: { apkPath, manifest: localManifest },
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(result.reason, 'mismatched');
  assert.equal(result.installed, true);
  assert.deepEqual(installs, [apkPath]);
});

test('installing a same-version different-sha helper evicts the stale install memo', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-helper-memo-evict-'));
  const apkPathA = path.join(tmpDir, 'helper-a.apk');
  const apkPathB = path.join(tmpDir, 'helper-b.apk');
  await fs.writeFile(apkPathA, 'helper-apk-a');
  await fs.writeFile(apkPathB, 'helper-apk-b');
  const manifestA = { ...manifest, sha256: sha256Text('helper-apk-a') };
  const manifestB = { ...manifest, sha256: sha256Text('helper-apk-b') };
  const deviceKey = 'android:memo-evict';
  let installedBytes = 'helper-apk-a';
  const installs: string[] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: `package:${manifest.packageName} versionCode:${manifest.versionCode}`,
        stderr: '',
      };
    }
    if (args[0] === 'shell' && args[1] === 'pm' && args[2] === 'path') {
      return { exitCode: 0, stdout: 'package:/data/app/helper/base.apk\n', stderr: '' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const adbProvider = {
    exec: adb,
    pull: async (_remotePath: string, localPath: string) => {
      await fs.writeFile(localPath, installedBytes);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    install: async (pathToInstall: string) => {
      installs.push(pathToInstall);
      installedBytes = await fs.readFile(pathToInstall, 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  const first = await ensureAndroidSnapshotHelper({
    adb,
    adbProvider,
    artifact: { apkPath: apkPathA, manifest: manifestA },
    deviceKey,
  });
  assert.equal(first.reason, 'current');

  // B replaces A in place: same packageName/versionCode, different APK bytes.
  const replaced = await ensureAndroidSnapshotHelper({
    adb,
    adbProvider,
    artifact: { apkPath: apkPathB, manifest: manifestB },
    deviceKey,
  });
  assert.equal(replaced.reason, 'mismatched');
  assert.equal(replaced.installed, true);

  // Selecting A again must re-inspect against the swapped binary instead of serving A's stale
  // 'current' memo, and reinstall A.
  const reinstalled = await ensureAndroidSnapshotHelper({
    adb,
    adbProvider,
    artifact: { apkPath: apkPathA, manifest: manifestA },
    deviceKey,
  });
  assert.equal(reinstalled.reason, 'mismatched');
  assert.equal(reinstalled.installed, true);
  assert.deepEqual(installs, [apkPathB, apkPathA]);
});

test('ensureAndroidSnapshotHelper caches successful install checks per device and helper version', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-helper-install-cache-'));
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const localManifest = {
    ...manifest,
    sha256: sha256Text('helper-apk'),
  };
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args.includes('--show-versioncode')) {
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const artifact = { apkPath, manifest: localManifest };

  const installed = await ensureAndroidSnapshotHelper({
    adb,
    artifact,
    deviceKey: 'android:emulator-5554',
  });
  await fs.rm(apkPath);
  const cached = await ensureAndroidSnapshotHelper({
    adb,
    artifact,
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(installed.reason, 'missing');
  assert.equal(cached.reason, 'current');
  assert.equal(cached.installed, false);
  assert.equal(cached.installedVersionCode, localManifest.versionCode);
  assert.deepEqual(calls, [
    [
      'shell',
      'cmd',
      'package',
      'list',
      'packages',
      '--show-versioncode',
      localManifest.packageName,
    ],
    ['install', '-r', '-t', apkPath],
  ]);

  await fs.writeFile(apkPath, 'helper-apk');
  await ensureAndroidSnapshotHelper({
    adb,
    artifact,
    deviceKey: 'android:device-2',
  });
  assert.equal(calls.length, 4);

  forgetAndroidSnapshotHelperInstall({
    deviceKey: 'android:emulator-5554',
    packageName: localManifest.packageName,
    versionCode: localManifest.versionCode,
  });
  await ensureAndroidSnapshotHelper({
    adb,
    artifact,
    deviceKey: 'android:emulator-5554',
  });
  assert.equal(calls.length, 6);
});

test('ensureAndroidSnapshotHelper always policy bypasses cached install result', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-helper-install-always-'));
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const localManifest = {
    ...manifest,
    sha256: sha256Text('helper-apk'),
  };
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: `package:${localManifest.packageName} versionCode:${localManifest.versionCode + 1}`,
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const artifact = { apkPath, manifest: localManifest };

  const cached = await ensureAndroidSnapshotHelper({
    adb,
    artifact,
    deviceKey: 'android:emulator-5554',
  });
  const forced = await ensureAndroidSnapshotHelper({
    adb,
    artifact,
    deviceKey: 'android:emulator-5554',
    installPolicy: 'always',
  });

  assert.equal(cached.reason, 'current');
  assert.equal(forced.reason, 'forced');
  assert.equal(forced.installed, true);
  assert.deepEqual(calls, [
    [
      'shell',
      'cmd',
      'package',
      'list',
      'packages',
      '--show-versioncode',
      localManifest.packageName,
    ],
    [
      'shell',
      'cmd',
      'package',
      'list',
      'packages',
      '--show-versioncode',
      localManifest.packageName,
    ],
    ['install', '-r', '-t', apkPath],
  ]);
});

test('shared Android helper verifier rejects snapshot helper checksum mismatch', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-helper-sha-'));
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'actual');

  await assert.rejects(
    () =>
      verifyAndroidHelperApkChecksum(apkPath, sha256Text('expected'), 'Android snapshot helper'),
    { message: 'Android snapshot helper APK checksum mismatch' },
  );
});

test('ensureAndroidSnapshotHelper never policy does not probe device', async () => {
  let called = false;
  const result = await ensureAndroidSnapshotHelper({
    adb: async () => {
      called = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    artifact: { apkPath: '/tmp/helper.apk', manifest },
    installPolicy: 'never',
  });

  assert.equal(called, false);
  assert.equal(result.installed, false);
  assert.equal(result.reason, 'skipped');
});

test('ensureAndroidSnapshotHelper uninstalls and retries when signatures differ', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-helper-reinstall-'));
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const calls: string[][] = [];
  let installAttempts = 0;

  const result = await ensureAndroidSnapshotHelper({
    adb: async (args) => {
      calls.push(args);
      if (args.includes('--show-versioncode')) {
        return {
          exitCode: 0,
          stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:1',
          stderr: '',
        };
      }
      if (args[0] === 'install') {
        installAttempts += 1;
        if (installAttempts === 1) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]',
          };
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    artifact: {
      apkPath,
      manifest: { ...manifest, sha256: sha256Text('helper-apk') },
    },
  });

  assert.equal(result.installed, true);
  assert.equal(result.reason, 'outdated');
  assert.deepEqual(calls[1], ['install', '-r', '-t', apkPath]);
  assert.deepEqual(calls[2], ['uninstall', 'com.callstack.agentdevice.snapshothelper']);
  assert.deepEqual(calls[3], ['install', '-r', '-t', apkPath]);
});

test('ensureAndroidSnapshotHelper uses provider install capability and semantic install options', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-helper-provider-install-'));
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const installCalls: Array<{
    apkPath: string;
    replace?: boolean;
    allowTestPackages?: boolean;
    allowDowngrade?: boolean;
    grantPermissions?: boolean;
  }> = [];
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const adbProvider: AndroidAdbProvider = {
    exec: adb,
    install: async (path, options) => {
      installCalls.push({
        apkPath: path,
        replace: options?.replace,
        allowTestPackages: options?.allowTestPackages,
        allowDowngrade: options?.allowDowngrade,
        grantPermissions: options?.grantPermissions,
      });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  const result = await ensureAndroidSnapshotHelper({
    adb,
    adbProvider,
    artifact: {
      apkPath,
      manifest: {
        ...manifest,
        installArgs: ['install', '-r', '-t', '-d', '-g'],
        sha256: sha256Text('helper-apk'),
      },
    },
  });

  assert.equal(result.installed, true);
  assert.deepEqual(installCalls, [
    {
      apkPath,
      replace: true,
      allowTestPackages: true,
      allowDowngrade: true,
      grantPermissions: true,
    },
  ]);
});

test('ensureAndroidSnapshotHelper retry install also uses provider install capability', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-helper-provider-retry-'));
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const adbCalls: string[][] = [];
  const installCalls: string[] = [];
  let installAttempts = 0;
  const adb: AndroidAdbExecutor = async (args) => {
    adbCalls.push(args);
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:1',
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const adbProvider: AndroidAdbProvider = {
    exec: adb,
    install: async (path) => {
      installCalls.push(path);
      installAttempts += 1;
      if (installAttempts === 1) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  const result = await ensureAndroidSnapshotHelper({
    adb,
    adbProvider,
    artifact: { apkPath, manifest: { ...manifest, sha256: sha256Text('helper-apk') } },
  });

  assert.equal(result.installed, true);
  assert.deepEqual(installCalls, [apkPath, apkPath]);
  assert.deepEqual(adbCalls[1], ['uninstall', 'com.callstack.agentdevice.snapshothelper']);
});

test('captureAndroidSnapshotWithHelper uses injected adb executor', async () => {
  let capturedArgs: string[] | undefined;
  const adb: AndroidAdbExecutor = async (args, options) => {
    if (args[0] === 'shell' && args[1] === 'rm') {
      assert.equal(options?.allowFailure, true);
      assert.equal(options?.timeoutMs, 5000);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    capturedArgs = args;
    assert.equal(options?.allowFailure, true);
    assert.equal(options?.timeoutMs, 14000);
    return {
      exitCode: 0,
      stdout: helperOutput({
        chunks: ['<hierarchy><node index="0" /></hierarchy>'],
        result: {
          ok: 'true',
          outputFormat: 'uiautomator-xml',
          waitForIdleTimeoutMs: '10',
          waitForIdleQuietMs: '5',
          timeoutMs: '9000',
          maxDepth: '64',
          maxNodes: '100',
        },
      }),
      stderr: '',
    };
  };

  const result = await captureAndroidSnapshotWithHelper({
    adb,
    waitForIdleTimeoutMs: 10,
    waitForIdleQuietMs: 5,
    timeoutMs: 9000,
    maxDepth: 64,
    maxNodes: 100,
    outputPath: '/sdcard/Android/data/com.callstack.agentdevice.snapshothelper/files/test.xml',
  });

  assert.deepEqual(capturedArgs, [
    'shell',
    'am',
    'instrument',
    '-w',
    '-e',
    'waitForIdleTimeoutMs',
    '10',
    '-e',
    'waitForIdleQuietMs',
    '5',
    '-e',
    'timeoutMs',
    '9000',
    '-e',
    'maxDepth',
    '64',
    '-e',
    'maxNodes',
    '100',
    '-e',
    'outputPath',
    '/sdcard/Android/data/com.callstack.agentdevice.snapshothelper/files/test.xml',
    'com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation',
  ]);
  assert.equal(result.xml, '<hierarchy><node index="0" /></hierarchy>');
  assert.equal(result.metadata.maxNodes, 100);
});

test('captureAndroidSnapshotWithHelper can read output file when chunks are disabled', async () => {
  const adbCalls: string[][] = [];
  const outputPath = '/sdcard/Download/agent-device-snapshot.xml';
  const adb: AndroidAdbExecutor = async (args) => {
    adbCalls.push(args);
    if (args[0] === 'shell' && args[1] === 'sh') {
      assert.equal(args.at(-1), outputPath);
      return {
        exitCode: 0,
        stdout: '<hierarchy><node index="0" /></hierarchy>',
        stderr: '',
      };
    }
    return {
      exitCode: 0,
      stdout: helperOutput({
        chunks: [],
        result: {
          ok: 'true',
          outputFormat: 'uiautomator-xml',
          waitForIdleTimeoutMs: '10',
          waitForIdleQuietMs: '5',
          timeoutMs: '9000',
          maxDepth: '64',
          maxNodes: '100',
        },
      }),
      stderr: '',
    };
  };

  const result = await captureAndroidSnapshotWithHelper({
    adb,
    waitForIdleTimeoutMs: 10,
    waitForIdleQuietMs: 5,
    timeoutMs: 9000,
    maxDepth: 64,
    maxNodes: 100,
    outputPath,
    emitChunks: false,
  });

  assert.deepEqual(adbCalls[0], [
    'shell',
    'am',
    'instrument',
    '-w',
    '-e',
    'waitForIdleTimeoutMs',
    '10',
    '-e',
    'waitForIdleQuietMs',
    '5',
    '-e',
    'timeoutMs',
    '9000',
    '-e',
    'maxDepth',
    '64',
    '-e',
    'maxNodes',
    '100',
    '-e',
    'outputPath',
    outputPath,
    '-e',
    'emitChunks',
    'false',
    'com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation',
  ]);
  assert.deepEqual(adbCalls[1], [
    'shell',
    'sh',
    '-c',
    'cat "$1"; status=$?; rm -f "$1"; exit "$status"',
    'agent-device-snapshot-helper-output',
    outputPath,
  ]);
  assert.equal(result.xml, '<hierarchy><node index="0" /></hierarchy>');
  assert.equal(result.metadata.maxNodes, 100);
});

test('captureAndroidSnapshotWithHelper gives adb command overhead beyond helper timeout', async () => {
  let commandTimeoutMs: number | undefined;
  await captureAndroidSnapshotWithHelper({
    adb: async (args, options) => {
      if (args[0] === 'shell' && args[1] === 'rm') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      commandTimeoutMs = options?.timeoutMs;
      return {
        exitCode: 0,
        stdout: helperOutput({
          chunks: ['<hierarchy><node index="0" /></hierarchy>'],
          result: {
            ok: 'true',
            outputFormat: 'uiautomator-xml',
            timeoutMs: '8000',
          },
        }),
        stderr: '',
      };
    },
    timeoutMs: 8000,
  });

  assert.equal(commandTimeoutMs, 13000);
});

test('captureAndroidSnapshotWithHelper wraps unparseable failed output with adb details', async () => {
  await assert.rejects(
    () =>
      captureAndroidSnapshotWithHelper({
        adb: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'instrumentation failed',
        }),
      }),
    (error) => {
      assert.equal(
        (error as Error).message,
        'Android snapshot helper failed before returning parseable output',
      );
      assert.equal((error as { details?: Record<string, unknown> }).details?.exitCode, 1);
      assert.equal(
        (error as { details?: Record<string, unknown> }).details?.stderr,
        'instrumentation failed',
      );
      return true;
    },
  );
});

test('captureAndroidSnapshotWithHelper reads helper output file when instrumentation output is unparseable', async () => {
  const calls: string[][] = [];
  const result = await captureAndroidSnapshotWithHelper({
    adb: async (args) => {
      calls.push(args);
      if (args[0] === 'shell' && args[1] === 'am') {
        return {
          exitCode: 0,
          stdout: 'INSTRUMENTATION_RESULT: shortMsg=Process crashed.',
          stderr: '',
        };
      }
      if (args[0] === 'shell' && args[1] === 'sh') {
        return {
          exitCode: 0,
          stdout: '<hierarchy><node text="file fallback"/></hierarchy>',
          stderr: '',
        };
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    },
    outputPath: '/sdcard/Android/data/com.callstack.agentdevice.snapshothelper/files/test.xml',
  });

  assert.equal(result.xml, '<hierarchy><node text="file fallback"/></hierarchy>');
  assert.equal(result.metadata.outputFormat, 'uiautomator-xml');
  assert.deepEqual(calls.at(1), [
    'shell',
    'sh',
    '-c',
    'cat "$1"; status=$?; rm -f "$1"; exit "$status"',
    'agent-device-snapshot-helper-output',
    '/sdcard/Android/data/com.callstack.agentdevice.snapshothelper/files/test.xml',
  ]);
});

test('parseAndroidSnapshotHelperManifest validates manifest shape', () => {
  assert.throws(() => parseAndroidSnapshotHelperManifest({ ...manifest, outputFormat: 'json' }), {
    message: 'Android snapshot helper manifest outputFormat must be "uiautomator-xml".',
  });
  assert.throws(() => parseAndroidSnapshotHelperManifest({ ...manifest, installArgs: ['shell'] }), {
    message: 'Android snapshot helper manifest installArgs must start with "install".',
  });
  assert.throws(
    () => parseAndroidSnapshotHelperManifest({ ...manifest, installArgs: ['install', '--user'] }),
    {
      message:
        'Android snapshot helper manifest installArgs contains unsupported install flag "--user".',
    },
  );
  assert.throws(() => parseAndroidSnapshotHelperManifest({ ...manifest, sha256: 'not-a-sha' }), {
    message: 'Android snapshot helper manifest sha256 must be a 64-character hex string.',
  });
  assert.equal(
    parseAndroidSnapshotHelperManifest({
      ...manifest,
      sha256: ` ${sha256Text('helper-apk').toUpperCase()} `,
    }).sha256,
    sha256Text('helper-apk'),
  );
});

function helperOutput(options: { chunks: string[]; result: Record<string, string> }): string {
  return [
    ...options.chunks.map((payload, index) =>
      statusRecord({
        chunkIndex: String(index),
        chunkCount: String(options.chunks.length),
        payloadBase64: encodeChunk(payload),
      }),
    ),
    resultRecord(options.result),
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');
}

function statusRecord(values: Record<string, string>): string {
  return [
    'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_STATUS: helperApiVersion=1',
    'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
    ...Object.entries(values).map(([key, value]) => `INSTRUMENTATION_STATUS: ${key}=${value}`),
    'INSTRUMENTATION_STATUS_CODE: 1',
  ].join('\n');
}

function encodeChunk(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function resultRecord(values: Record<string, string>): string {
  return [
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_RESULT: helperApiVersion=1',
    ...Object.entries(values).map(([key, value]) => `INSTRUMENTATION_RESULT: ${key}=${value}`),
  ].join('\n');
}

function sha256Text(value: string): string {
  return sha256Buffer(Buffer.from(value));
}

function sha256Buffer(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
