// The `adb-executor` entry surface, kept for the root shim and the transitional #2041
// consumers. The implementation lives in focused owners: `adb-transport.ts` (vocabulary),
// `adb-failure.ts` (classification + hint enrichment), `adb-provider-normalization.ts`,
// `adb-provider-scope.ts` (request-scoped provider seam and routing),
// `adb-port-reverse.ts` (owner-tracked reverse mappings), and `adb-transfer.ts`
// (pull/install funnels).

export {
  androidAdbResultError,
  attachAdbFailureHint,
  classifyAndroidAdbFailure as classifyAdbFailure,
} from './adb-failure.ts';
export { createAndroidPortReverseManager } from './adb-port-reverse.ts';
export {
  createDeviceAdbExecutor,
  createLocalAndroidAdbProvider,
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  resolveAndroidTextInjector,
  resolveAndroidTouchProvider,
  resolveScopedAndroidAdbBackgroundTransport,
  withAndroidAdbProvider,
} from './adb-provider-scope.ts';
export { installAndroidAdbPackage, pullAndroidAdbFile } from './adb-transfer.ts';
export type {
  AndroidAdbExecutor,
  AndroidAdbExecutorOptions,
  AndroidAdbExecutorResult,
  AndroidAdbProcess,
  AndroidAdbProvider,
  AndroidPortReverseEndpoint,
  AndroidTextInputAction,
  AndroidTouchInjector,
} from './adb-transport.ts';
