import { fileURLToPath } from 'node:url';
import type { AndroidImeHelperArtifact } from '@agent-device/platform-android/mechanics';

const IME_HELPER_PACKAGE = 'com.callstack.agentdevice.imehelper';
const IME_HELPER_FIXTURE_APK_PATH = fileURLToPath(
  new URL('./fixtures/android-helper-apk.fixture', import.meta.url),
);
const IME_HELPER_FIXTURE_APK_SHA256 =
  'a5f6a2fba1163bba2f13026bd3a192f52ba2816524b7cfa83c6b7ca568f6710a';

/**
 * A provider-supplied test IME helper, so a scenario exercises the real durable
 * activation/recovery path without depending on the npm-bundled artifact being built.
 */
export const ANDROID_IME_HELPER_FIXTURE_ARTIFACT: AndroidImeHelperArtifact = {
  apkPath: IME_HELPER_FIXTURE_APK_PATH,
  manifest: {
    name: 'android-ime-helper',
    version: '0.13.3',
    assetName: 'android-helper-apk.fixture',
    sha256: IME_HELPER_FIXTURE_APK_SHA256,
    packageName: IME_HELPER_PACKAGE,
    versionCode: 13003,
    serviceComponent: `${IME_HELPER_PACKAGE}/.TestInputMethodService`,
    broadcastProtocol: 'android-ime-helper-v1',
  },
};
