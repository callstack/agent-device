// Thin re-export shim over the extracted cluster in @agent-device/platform-android.
// TODO(#2041): delete together with the adb-executor shim once the in-flight perf/trace
// handler migration lands and the remaining root consumers repoint to the package.
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
  type AndroidTestImeActivationResult,
  type AndroidTestImeRestoreReason,
  type AndroidTestImeRestoreResult,
} from '@agent-device/platform-android/ime-lifecycle';
