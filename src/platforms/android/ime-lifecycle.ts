// Thin re-export shim over the extracted cluster in @agent-device/platform-android, trimmed to
// the names live root and test-support code still consumes. TODO(#2041): delete together with the
// adb-executor shim after those callers import the package-owned seams directly.
import './adb-host-binding.ts';

export {
  activateAndroidTestIme,
  ANDROID_TEST_IME_SETTINGS_KEYS,
  isAndroidTestImeActive,
  listAndroidAdbSerialsQuick,
  readAndroidDefaultInputMethod,
  resetAndroidTestImeActivationCacheForTests,
  restoreAndroidTestIme,
  restoreOrphanedAndroidTestImeOnDaemonStartup,
  setAndroidTestImeActiveForTests,
} from '@agent-device/platform-android/ime-lifecycle';
