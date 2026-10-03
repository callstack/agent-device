import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { test } from 'vitest';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import { mkdtempForTest } from './__tests__/test-utils/tmp-dir.ts';
import {
  ANDROID_MANIFEST_APK_FIXTURE_PATH,
  ANDROID_MANIFEST_FIXTURE_PACKAGE,
} from './manifest.fixtures.ts';
import { installAndroidArtifact } from './deployment/native.ts';
import { prepareAndroidInstallArtifact } from './install-artifact.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

/**
 * A device that already carries the app: its package inventory is identical before and after the
 * install, so the before/after diff resolves nothing. Every adb call is recorded so a test can say
 * whether identity came from the artifact or from the device.
 */
function hostWithUnchangedInventory(): PlatformRuntimeHost & { adbCalls: string[][] } {
  const adbCalls: string[][] = [];
  const host = {
    adbCalls,
    androidTools: {
      installPackage: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      runAdb: async (_device: unknown, args: string[]) => {
        adbCalls.push(args);
        return {
          stdout: `package:${ANDROID_MANIFEST_FIXTURE_PACKAGE}\npackage:com.android.shell\n`,
          stderr: '',
          exitCode: 0,
        };
      },
    },
  } as unknown as PlatformRuntimeHost & { adbCalls: string[][] };
  return host;
}

test('installing an already-installed APK resolves its package with no aapt reachable', async () => {
  // The stub host answers `isExecutable` as false, so no `aapt` is reachable: the package must
  // come from the artifact's binary manifest, and the install must carry it through although the
  // device inventory adds nothing. The closest negative — the same install without the artifact
  // identity resolving nothing — lives in deployment/native.test.ts.
  bindAndroidAdbHostStub();
  const tempRoot = await mkdtempForTest('agent-device-android-reinstall-');
  const apkPath = path.join(tempRoot, 'app.apk');
  await fs.copyFile(ANDROID_MANIFEST_APK_FIXTURE_PATH, apkPath);

  const artifact = await prepareAndroidInstallArtifact({ kind: 'path', path: apkPath });
  try {
    assert.equal(artifact.packageName, ANDROID_MANIFEST_FIXTURE_PACKAGE);
    const host = hostWithUnchangedInventory();
    const packageName = await installAndroidArtifact(
      host,
      device,
      artifact.installablePath,
      artifact.packageName,
      new AbortController().signal,
    );
    assert.equal(packageName, ANDROID_MANIFEST_FIXTURE_PACKAGE);
    assert.deepEqual(host.adbCalls, []);
  } finally {
    await artifact.cleanup();
  }
});
