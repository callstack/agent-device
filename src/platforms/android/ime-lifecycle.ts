// Thin re-export shim over the extracted cluster in @agent-device/platform-android, trimmed to
// the names root code still consumes. TODO(#2041): delete together with the adb-executor shim
// once the in-flight perf/trace handler migration lands.
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
