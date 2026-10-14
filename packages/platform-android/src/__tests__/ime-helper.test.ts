import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  ensureAndroidImeHelper,
  resetAndroidImeHelperInstallCache,
  sendAndroidImeHelperText,
  clearAndroidImeHelperText,
} from '../ime-helper.ts';
import type { AndroidAdbExecutor, AndroidAdbProvider } from '../adb-executor.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

const PACKAGE = 'com.callstack.agentdevice.imehelper';
const LATIN_IME = 'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME';

const manifest = {
  name: 'android-ime-helper' as const,
  version: '0.19.2',
  assetName: 'helper.apk',
  sha256: 'a'.repeat(64),
  packageName: PACKAGE,
  versionCode: 19002,
  serviceComponent: 'com.callstack.agentdevice.imehelper/.TestInputMethodService',
  broadcastProtocol: 'android-ime-helper-v1' as const,
};

beforeEach(() => {
  resetAndroidImeHelperInstallCache();
});

test('sendAndroidImeHelperText package-scopes the broadcast and base64-encodes UTF-8', async () => {
  let capturedArgs: readonly string[] | undefined;
  await sendAndroidImeHelperText(
    async (args) => {
      capturedArgs = args;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    PACKAGE,
    '你好世界 😀',
  );

  assert.ok(capturedArgs);
  // Package-scoped delivery to the in-process receiver; the app-side WRITE_SECURE_SETTINGS
  // permission gate (asserted in ime-helper-security.test.ts) is the trust boundary.
  assert.deepEqual(capturedArgs.slice(0, 6), ['shell', 'am', 'broadcast', '-p', PACKAGE, '-a']);
  assert.equal(capturedArgs[6], 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64');
  const textIndex = capturedArgs.indexOf('text');
  assert.ok(textIndex > 0);
  const payloadBase64 = capturedArgs[textIndex + 1];
  assert.ok(payloadBase64);
  assert.equal(Buffer.from(payloadBase64, 'base64').toString('utf8'), '你好世界 😀');
});

test('clearAndroidImeHelperText broadcasts ACTION_CLEAR_TEXT without a text extra', async () => {
  let capturedArgs: readonly string[] | undefined;
  await clearAndroidImeHelperText(async (args) => {
    capturedArgs = args;
    return { exitCode: 0, stdout: '', stderr: '' };
  }, PACKAGE);

  assert.ok(capturedArgs);
  assert.deepEqual(capturedArgs.slice(0, 5), ['shell', 'am', 'broadcast', '-p', PACKAGE]);
  assert.ok(capturedArgs.includes('com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT'));
  assert.ok(!capturedArgs.includes('text'));
});

test('a failed broadcast raises COMMAND_FAILED', async () => {
  await assert.rejects(
    sendAndroidImeHelperText(
      async () => ({ exitCode: 1, stdout: '', stderr: 'broadcast failed' }),
      PACKAGE,
      'hi',
    ),
    /COMMAND_FAILED|Android IME helper broadcast failed/,
  );
});

test('ensureAndroidImeHelper installs with semantic provider install options', async () => {
  const tmpDir = await mkdtempForTest('ime-helper-install-');
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const installCalls: Array<{
    apkPath: string;
    replace?: boolean;
  }> = [];
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }
    if (isImeListCall(args)) {
      return { exitCode: 0, stdout: `${manifest.serviceComponent}\n`, stderr: '' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const adbProvider: AndroidAdbProvider = {
    exec: adb,
    install: async (installApkPath, options) => {
      installCalls.push({
        apkPath: installApkPath,
        replace: options?.replace,
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
  assert.deepEqual(installCalls, [{ apkPath, replace: true }]);
});

test('ensureAndroidImeHelper skips install when a newer version is already present', async () => {
  const tmpDir = await mkdtempForTest('ime-helper-current-');
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: `package:${manifest.packageName} versionCode:${manifest.versionCode + 1}`,
        stderr: '',
      };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const adbProvider: AndroidAdbProvider = {
    exec: adb,
    install: async () => {
      throw new Error('install should not be called when a newer version is present');
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

test('ensureAndroidImeHelper returns from an install once the IME is registered', async () => {
  const tmpDir = await mkdtempForTest('ime-helper-registration-');
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  let imeListCalls = 0;
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (isImeListCall(args)) {
      imeListCalls += 1;
      const helper = imeListCalls > 1 ? `${manifest.serviceComponent}\n` : '';
      return { exitCode: 0, stdout: `${LATIN_IME}\n${helper}`, stderr: '' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const adbProvider: AndroidAdbProvider = {
    exec: adb,
    install: async () => ({ exitCode: 0, stdout: 'Success', stderr: '' }),
  };

  const result = await ensureAndroidImeHelper({
    adb,
    adbProvider,
    artifact: { apkPath, manifest: { ...manifest, sha256: sha256Text('helper-apk') } },
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(result.installed, true);
  assert.equal(imeListCalls, 2);
});

test('ensureAndroidImeHelper returns the install when the registration listing times out', async () => {
  const tmpDir = await mkdtempForTest('ime-helper-registration-timeout-');
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (isImeListCall(args)) {
      throw new AppError('COMMAND_FAILED', 'adb timed out after 5000ms', {
        stdout: '',
        stderr: '',
        exitCode: 1,
        timeoutMs: 5_000,
      });
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const adbProvider: AndroidAdbProvider = {
    exec: adb,
    install: async () => ({ exitCode: 0, stdout: 'Success', stderr: '' }),
  };

  const result = await ensureAndroidImeHelper({
    adb,
    adbProvider,
    artifact: { apkPath, manifest: { ...manifest, sha256: sha256Text('helper-apk') } },
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(result.installed, true);
});

test('ensureAndroidImeHelper reinstalls a remembered helper the device no longer has', async () => {
  const tmpDir = await mkdtempForTest('ime-helper-removed-');
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  let present = false;
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return present
        ? {
            exitCode: 0,
            stdout: `package:${manifest.packageName} versionCode:${manifest.versionCode}`,
            stderr: '',
          }
        : { exitCode: 0, stdout: '', stderr: '' };
    }
    if (isImeListCall(args)) {
      return { exitCode: 0, stdout: `${manifest.serviceComponent}\n`, stderr: '' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  let installs = 0;
  const adbProvider: AndroidAdbProvider = {
    exec: adb,
    install: async () => {
      installs += 1;
      present = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const ensure = () =>
    ensureAndroidImeHelper({
      adb,
      adbProvider,
      artifact: { apkPath, manifest: { ...manifest, sha256: sha256Text('helper-apk') } },
      deviceKey: 'android:emulator-5554',
    });

  assert.equal((await ensure()).installed, true);
  assert.equal((await ensure()).installed, false);
  present = false;
  const result = await ensure();

  assert.equal(result.installed, true);
  assert.equal(result.reason, 'missing');
  assert.equal(installs, 2);
});

test('ensureAndroidImeHelper install timeout points at the OEM install dialog', async () => {
  const tmpDir = await mkdtempForTest('ime-helper-install-timeout-');
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const adbProvider: AndroidAdbProvider = {
    exec: adb,
    install: async () => {
      // An unattended first install blocks on the OEM install-confirmation dialog until
      // adb gives up, leaving no output behind.
      throw new AppError('COMMAND_FAILED', 'adb timed out after 30000ms', {
        stdout: '',
        stderr: '',
        exitCode: 1,
        timeoutMs: 30_000,
      });
    },
  };

  await assert.rejects(
    () =>
      ensureAndroidImeHelper({
        adb,
        adbProvider,
        artifact: { apkPath, manifest: { ...manifest, sha256: sha256Text('helper-apk') } },
        deviceKey: 'android:R52N30PZXBT',
      }),
    (error) => {
      const details = (error as AppError).details;
      assert.equal(details?.adbFailure, 'timeout');
      assert.match(String(details?.hint), /install-confirmation dialog/);
      assert.doesNotMatch(String(details?.hint), /wedged/);
      return true;
    },
  );
});

function isImeListCall(args: readonly string[]): boolean {
  return args.includes('ime') && args.includes('list');
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
