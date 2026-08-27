// Thin re-export shim over the extracted cluster in @agent-device/platform-android, trimmed to
// the names live root runtime, core interactor, SDK, and test-support code still consumes; anything
// else imports the package subpath directly. TODO(#2041): delete this shim after those callers move
// to package-owned seams.
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
  runAndroidHostAdb,
  withAndroidAdbProvider,
  withAndroidHostAdbTransport,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
  type AndroidAdbProcess,
  type AndroidAdbProvider,
  type AndroidPortReverseEndpoint,
  type AndroidTextInputAction,
} from '@agent-device/platform-android/adb-executor';
