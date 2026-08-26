// Thin re-export shim over the extracted cluster in @agent-device/platform-android, trimmed to
// the names root code still consumes; anything else imports the package subpath directly.
// TODO(#2041): the in-flight perf/trace handler migration (session-perf.ts,
// session-perf-legacy.ts, session-native-perf.ts) still imports this path; delete this shim
// (repointing remaining root consumers) once that migration lands.
import './adb-host-binding.ts';

export {
  androidAdbResultError,
  attachAdbFailureHint,
  classifyAdbFailure,
  createAndroidPortReverseManager,
  createDeviceAdbExecutor,
  createLocalAndroidAdbProvider,
  installAndroidAdbPackage,
  pullAndroidAdbFile,
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  resolveAndroidTextInjector,
  resolveAndroidTouchProvider,
  resolveScopedAndroidAdbBackgroundTransport,
  withAndroidAdbProvider,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
  type AndroidAdbProcess,
  type AndroidAdbProvider,
  type AndroidPortReverseEndpoint,
  type AndroidTextInputAction,
} from '@agent-device/platform-android/adb-executor';
