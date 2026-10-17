import assert from 'node:assert/strict';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { test } from 'vitest';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import {
  ANDROID_MANIFEST_APK_FIXTURE_PATH,
  ANDROID_MANIFEST_FIXTURE_PACKAGE,
} from './manifest.fixtures.ts';
import { installAndroidArtifact } from './deployment/native.ts';
import { prepareAndroidInstallArtifact } from './install-artifact.ts';
import { ANDROID_EMULATOR } from './__tests__/test-utils/device-fixtures.ts';

test('installing an already-installed APK resolves its package with no aapt reachable', async () => {
  // The stub host answers `isExecutable` as false, so no `aapt` is reachable and the identity can
  // only come from the artifact's binary manifest. The device inventory is identical before and
  // after — the diff resolves nothing — and no adb call may run. The closest negative — the same
  // install without the artifact identity — lives in deployment/native.test.ts.
  bindAndroidAdbHostStub();
  const artifact = await prepareAndroidInstallArtifact({
    kind: 'path',
    path: ANDROID_MANIFEST_APK_FIXTURE_PATH,
  });
  try {
    assert.equal(artifact.packageName, ANDROID_MANIFEST_FIXTURE_PACKAGE);
    const adbCalls: string[][] = [];
    const stdout = `package:${ANDROID_MANIFEST_FIXTURE_PACKAGE}\npackage:com.android.shell\n`;
    const host = {
      androidTools: {
        installPackage: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runAdb: async (_device: unknown, args: string[]) => {
          adbCalls.push(args);
          return { stdout, stderr: '', exitCode: 0 };
        },
      },
    } as unknown as PlatformRuntimeHost;
    const packageName = await installAndroidArtifact(
      host,
      ANDROID_EMULATOR,
      artifact.installablePath,
      artifact.packageName,
      new AbortController().signal,
    );
    assert.equal(packageName, ANDROID_MANIFEST_FIXTURE_PACKAGE);
    assert.deepEqual(adbCalls, []);
  } finally {
    await artifact.cleanup();
  }
});
