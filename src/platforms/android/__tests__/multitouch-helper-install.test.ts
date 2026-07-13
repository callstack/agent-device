import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { ensureAndroidMultiTouchHelper } from '../multitouch-helper-install.ts';
import type { AndroidAdbExecutor, AndroidAdbProvider } from '../adb-executor.ts';
import { ANDROID_MULTITOUCH_HELPER_MANIFEST } from './multitouch-helper.fixtures.ts';

test('helper install uses replace and test-package semantics', async () => {
  const fixture = await makeInstallFixture('helper-apk');
  const installCalls: unknown[] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const provider: AndroidAdbProvider = {
    exec: adb,
    install: async (installedPath, options) => {
      installCalls.push({ installedPath, options });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  const result = await ensureAndroidMultiTouchHelper({
    adb,
    adbProvider: provider,
    artifact: fixture.artifact,
    deviceKey: 'android:install-semantics',
  });

  assert.equal(result.reason, 'missing');
  assert.deepEqual(installCalls, [
    {
      installedPath: fixture.artifact.apkPath,
      options: {
        replace: true,
        allowTestPackages: true,
        allowFailure: true,
        timeoutMs: 30_000,
      },
    },
  ]);
});

test('same-version helper is current only when installed APK bytes match', async () => {
  const fixture = await makeInstallFixture('current-helper');
  const { adb, provider, pulls, installs } = makeInstalledHelperDevice({
    versionCode: fixture.artifact.manifest.versionCode,
    installedApk: 'current-helper',
  });

  const result = await ensureAndroidMultiTouchHelper({
    adb,
    adbProvider: provider,
    artifact: fixture.artifact,
    deviceKey: 'android:matching-bytes',
  });

  assert.equal(result.reason, 'current');
  assert.equal(result.installed, false);
  assert.equal(result.installedSha256, fixture.artifact.manifest.sha256);
  assert.equal(pulls.length, 1);
  assert.equal(installs.length, 0);
});

test('same-version helper is replaced when installed APK bytes differ', async () => {
  const fixture = await makeInstallFixture('current-helper');
  const { adb, provider, installs } = makeInstalledHelperDevice({
    versionCode: fixture.artifact.manifest.versionCode,
    installedApk: 'stale-helper',
  });

  const result = await ensureAndroidMultiTouchHelper({
    adb,
    adbProvider: provider,
    artifact: fixture.artifact,
    deviceKey: 'android:mismatched-bytes',
  });

  assert.equal(result.reason, 'mismatched');
  assert.equal(result.installed, true);
  assert.equal(installs.length, 1);
});

test('same-version helper is replaced when installed APK identity is unavailable', async () => {
  const fixture = await makeInstallFixture('current-helper');
  const { adb, provider, installs } = makeInstalledHelperDevice({
    versionCode: fixture.artifact.manifest.versionCode,
    pullError: new Error('remote pull unavailable'),
  });

  const result = await ensureAndroidMultiTouchHelper({
    adb,
    adbProvider: provider,
    artifact: fixture.artifact,
    deviceKey: 'android:unverifiable-identity',
  });

  assert.equal(result.reason, 'unverifiable');
  assert.equal(result.installed, true);
  assert.equal(installs.length, 1);
});

test('newer installed helper remains current without an unsafe downgrade', async () => {
  const fixture = await makeInstallFixture('current-helper');
  const { adb, provider, pulls, installs } = makeInstalledHelperDevice({
    versionCode: fixture.artifact.manifest.versionCode + 1,
  });

  const result = await ensureAndroidMultiTouchHelper({
    adb,
    adbProvider: provider,
    artifact: fixture.artifact,
    deviceKey: 'android:newer-helper',
  });

  assert.equal(result.reason, 'current');
  assert.equal(result.installed, false);
  assert.equal(pulls.length, 0);
  assert.equal(installs.length, 0);
});

test('install memo includes artifact identity, not only version code', async () => {
  const first = await makeInstallFixture('first-helper');
  const second = await makeInstallFixture('second-helper');
  const device = makeInstalledHelperDevice({
    versionCode: first.artifact.manifest.versionCode,
    installedApk: 'first-helper',
  });

  await ensureAndroidMultiTouchHelper({
    adb: device.adb,
    adbProvider: device.provider,
    artifact: first.artifact,
    deviceKey: 'android:artifact-identity',
  });
  device.setInstalledApk('first-helper');
  const result = await ensureAndroidMultiTouchHelper({
    adb: device.adb,
    adbProvider: device.provider,
    artifact: second.artifact,
    deviceKey: 'android:artifact-identity',
  });

  assert.equal(result.reason, 'mismatched');
  assert.equal(result.installed, true);
});

test('install memo skips repeated APK reads for the same artifact identity', async () => {
  const fixture = await makeInstallFixture('current-helper');
  const device = makeInstalledHelperDevice({
    versionCode: fixture.artifact.manifest.versionCode,
    installedApk: 'current-helper',
  });

  await ensureAndroidMultiTouchHelper({
    adb: device.adb,
    adbProvider: device.provider,
    artifact: fixture.artifact,
    deviceKey: 'android:install-memo',
  });
  await fs.rm(fixture.artifact.apkPath);
  const result = await ensureAndroidMultiTouchHelper({
    adb: async () => {
      throw new Error('cached ensure should not access adb');
    },
    adbProvider: {
      exec: async () => {
        throw new Error('cached ensure should not access the provider');
      },
    },
    artifact: fixture.artifact,
    deviceKey: 'android:install-memo',
  });

  assert.equal(result.reason, 'current');
  assert.equal(result.installed, false);
});

async function makeInstallFixture(apk: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'multitouch-helper-identity-'));
  const apkPath = path.join(directory, 'helper.apk');
  await fs.writeFile(apkPath, apk);
  return {
    artifact: {
      apkPath,
      manifest: {
        ...ANDROID_MULTITOUCH_HELPER_MANIFEST,
        sha256: sha256Text(apk),
      },
    },
  };
}

function makeInstalledHelperDevice(options: {
  versionCode: number;
  installedApk?: string;
  pullError?: Error;
}) {
  let installedApk = options.installedApk;
  const pulls: Array<{ remotePath: string; localPath: string }> = [];
  const installs: string[] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: `package:${ANDROID_MULTITOUCH_HELPER_MANIFEST.packageName} versionCode:${options.versionCode}`,
        stderr: '',
      };
    }
    if (args[0] === 'shell' && args[1] === 'pm' && args[2] === 'path') {
      return { exitCode: 0, stdout: 'package:/data/app/helper/base.apk\n', stderr: '' };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
  const provider: AndroidAdbProvider = {
    exec: adb,
    pull: async (remotePath, localPath) => {
      pulls.push({ remotePath, localPath });
      if (options.pullError) throw options.pullError;
      if (installedApk === undefined) throw new Error('installed APK fixture is missing');
      await fs.writeFile(localPath, installedApk);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    install: async (apkPath) => {
      installs.push(apkPath);
      installedApk = await fs.readFile(apkPath, 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  return {
    adb,
    provider,
    pulls,
    installs,
    setInstalledApk(value: string) {
      installedApk = value;
    },
  };
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
