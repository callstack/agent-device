import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'vitest';
import {
  ensureAndroidImeHelper,
  resetAndroidImeHelperInstallCache,
  sendAndroidImeHelperText,
  clearAndroidImeHelperText,
  sendAndroidImeHelperEnter,
} from '../ime-helper.ts';
import type { AndroidAdbExecutor, AndroidAdbProvider } from '../adb-executor.ts';

const manifest = {
  name: 'android-ime-helper' as const,
  version: '0.19.2',
  assetName: 'helper.apk',
  sha256: 'a'.repeat(64),
  packageName: 'com.callstack.agentdevice.imehelper',
  versionCode: 19002,
  serviceComponent: 'com.callstack.agentdevice.imehelper/.TestInputMethodService',
  broadcastProtocol: 'android-ime-helper-v1' as const,
};

beforeEach(() => {
  resetAndroidImeHelperInstallCache();
});

test('sendAndroidImeHelperText base64-encodes UTF-8 text and targets the package', async () => {
  let capturedArgs: string[] | undefined;
  await sendAndroidImeHelperText(
    async (args) => {
      capturedArgs = args;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    manifest.packageName,
    '你好世界 😀',
  );

  assert.ok(capturedArgs);
  assert.deepEqual(capturedArgs.slice(0, 6), [
    'shell',
    'am',
    'broadcast',
    '-p',
    manifest.packageName,
    '-a',
  ]);
  assert.equal(capturedArgs[6], 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64');
  const textIndex = capturedArgs.indexOf('text');
  assert.ok(textIndex > 0);
  const payloadBase64 = capturedArgs[textIndex + 1];
  assert.ok(payloadBase64);
  assert.equal(Buffer.from(payloadBase64, 'base64').toString('utf8'), '你好世界 😀');
});

test('clearAndroidImeHelperText broadcasts ACTION_CLEAR_TEXT without a text extra', async () => {
  let capturedArgs: string[] | undefined;
  await clearAndroidImeHelperText(async (args) => {
    capturedArgs = args;
    return { exitCode: 0, stdout: '', stderr: '' };
  }, manifest.packageName);

  assert.ok(capturedArgs);
  assert.ok(capturedArgs.includes('com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT'));
  assert.ok(!capturedArgs.includes('text'));
});

test('sendAndroidImeHelperEnter broadcasts ACTION_ENTER', async () => {
  let capturedArgs: string[] | undefined;
  await sendAndroidImeHelperEnter(async (args) => {
    capturedArgs = args;
    return { exitCode: 0, stdout: '', stderr: '' };
  }, manifest.packageName);

  assert.ok(capturedArgs);
  assert.ok(capturedArgs.includes('com.callstack.agentdevice.imehelper.ACTION_ENTER'));
});

test('a failed broadcast raises COMMAND_FAILED', async () => {
  await assert.rejects(
    sendAndroidImeHelperText(
      async () => ({ exitCode: 1, stdout: '', stderr: 'broadcast failed' }),
      manifest.packageName,
      'hi',
    ),
    /COMMAND_FAILED|Android IME helper broadcast failed/,
  );
});

test('ensureAndroidImeHelper installs with semantic provider install options', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ime-helper-install-'));
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const installCalls: Array<{
    apkPath: string;
    replace?: boolean;
    allowTestPackages?: boolean;
  }> = [];
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const adbProvider: AndroidAdbProvider = {
    exec: adb,
    install: async (installApkPath, options) => {
      installCalls.push({
        apkPath: installApkPath,
        replace: options?.replace,
        allowTestPackages: options?.allowTestPackages,
      });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  const result = await ensureAndroidImeHelper({
    adb,
    adbProvider,
    artifact: { apkPath, manifest: { ...manifest, sha256: sha256Text('helper-apk') } },
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(result.installed, true);
  assert.equal(result.reason, 'missing');
  assert.deepEqual(installCalls, [{ apkPath, replace: true, allowTestPackages: true }]);
});

test('ensureAndroidImeHelper skips install when an equal-or-newer version is already present', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ime-helper-current-'));
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: `package:${manifest.packageName} versionCode:${manifest.versionCode}`,
        stderr: '',
      };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const adbProvider: AndroidAdbProvider = {
    exec: adb,
    install: async () => {
      throw new Error('install should not be called when the version is current');
    },
  };

  const result = await ensureAndroidImeHelper({
    adb,
    adbProvider,
    artifact: { apkPath, manifest: { ...manifest, sha256: sha256Text('helper-apk') } },
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(result.installed, false);
  assert.equal(result.reason, 'current');
});

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
