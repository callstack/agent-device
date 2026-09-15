import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  ensureAndroidSnapshotHelper,
  resetAndroidSnapshotHelperInstallCache,
} from '../snapshot-helper-install.ts';
import type { AndroidAdbExecutor, AndroidAdbProvider } from '../adb-executor.ts';
import type { AndroidAdbInstaller } from '../adb-transport.ts';
import type { AndroidSnapshotHelperManifest } from '../snapshot-helper-types.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

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
};

beforeEach(() => {
  resetAndroidSnapshotHelperInstallCache();
});

test('a snapshot helper install timeout points at the OEM install dialog', async () => {
  const apkPath = await writeHelperApk('snapshot-helper-install-timeout-');
  const adbProvider = missingPackageProvider(async () => {
    throw adbInstallTimeout();
  });

  await assert.rejects(
    () =>
      ensureAndroidSnapshotHelper({
        adb: adbProvider.exec,
        adbProvider,
        artifact: { apkPath, manifest: { ...manifest, sha256: sha256Text('helper-apk') } },
        deviceKey: 'android:R52N30PZXBT',
      }),
    (error) => {
      const details = (error as AppError).details;
      assert.equal(details?.adbFailure, 'timeout');
      assert.equal(details?.androidSnapshotHelperInstallFailure, true);
      assert.match(String(details?.hint), /install-confirmation dialog/);
      assert.doesNotMatch(String(details?.hint), /wedged/);
      return true;
    },
  );
});

test('an exec-shaped helper install timeout names the dialog, not a wedged adb server', async () => {
  // The reporter's shape: a local USB device whose provider has no semantic installer, so the
  // install crosses the legacy exec fallback.
  const apkPath = await writeHelperApk('snapshot-helper-install-timeout-exec-');
  const exec: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'install') throw adbInstallTimeout();
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };

  await assert.rejects(
    () =>
      ensureAndroidSnapshotHelper({
        adb: exec,
        adbProvider: exec,
        artifact: { apkPath, manifest: { ...manifest, sha256: sha256Text('helper-apk') } },
        deviceKey: 'android:R52N30PZXBT',
      }),
    (error) => {
      const details = (error as AppError).details;
      assert.equal(details?.adbFailure, 'timeout');
      assert.match(String(details?.hint), /install-confirmation dialog/);
      return true;
    },
  );
});

function adbInstallTimeout(): AppError {
  // An unattended first install on ColorOS: adb blocks on the system install-confirmation dialog
  // and the exec layer kills the command, so stdout/stderr stay empty.
  return new AppError('COMMAND_FAILED', 'adb timed out after 30000ms', {
    stdout: '',
    stderr: '',
    exitCode: 1,
    timeoutMs: 30_000,
  });
}

async function writeHelperApk(prefix: string): Promise<string> {
  const tmpDir = await mkdtempForTest(prefix);
  const apkPath = path.join(tmpDir, 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  return apkPath;
}

function missingPackageProvider(install: AndroidAdbInstaller): AndroidAdbProvider {
  return {
    exec: async (args) => {
      if (args.includes('--show-versioncode')) {
        return { exitCode: 1, stdout: '', stderr: 'not found' };
      }
      throw new Error(`unexpected adb call: ${args.join(' ')}`);
    },
    install,
  };
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
