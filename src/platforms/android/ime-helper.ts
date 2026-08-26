// Thin re-export shim over the extracted cluster in @agent-device/platform-android.
// TODO(#2041): delete together with the adb-executor shim once the in-flight perf/trace
// handler migration lands and the remaining root consumers repoint to the package.
import './adb-host-binding.ts';

export {
  ANDROID_IME_HELPER_SERVICE_COMPONENT,
  clearAndroidImeHelperText,
  ensureAndroidImeHelper,
  getAndroidImeHelperDeviceKey,
  isAndroidImeHelperPackage,
  resetAndroidImeHelperInstallCache,
  resolveAndroidImeHelperArtifact,
  selectAndroidImeHelperArtifact,
  sendAndroidImeHelperText,
} from '@agent-device/platform-android/ime-helper';
