export {
  classifyAndroidInputOwner,
  classifyAndroidInputOwnership,
  isAndroidInputMethodNode,
  isAndroidInputMethodOwnedNode,
  isFallbackAndroidInputMethodPackage,
  isFallbackAndroidInputMethodResource,
  parseAndroidInputMethodPackage,
  readAndroidActiveInputMethodPackage,
} from '../android-input-ownership.ts';
export type {
  AndroidInputOwner,
  AndroidInputOwnership,
  AndroidInputOwnershipSource,
} from '../android-input-ownership.ts';
export {
  ANDROID_CONTENT_RECOVERY_REASONS,
  isAndroidContentRecoveryReason,
  isUnreadableCaptureContentError,
} from '../android-snapshot-quality.ts';
export type { AndroidContentRecoveryReason } from '../android-snapshot-quality.ts';
export {
  ANDROID_SYSTEM_CHROME_PACKAGE,
  hasAndroidSystemChromeProvenance,
  isAndroidSystemChromeWindowResourceId,
  stripAndroidSystemChromeProvenance,
  stripAndroidSystemChromeProvenanceFromNode,
} from '../android-system-chrome.ts';
export type { AndroidSystemChromeProvenance } from '../android-system-chrome.ts';
export { assertAppleMultiTouchSupported } from '../apple-multitouch-support.ts';
export { emptyAudioProbeResult, normalizeAudioProbeRecord } from '../audio-probe-result.ts';
export type {
  AudioProbeResult,
  AudioProbeSource,
  EmptyAudioProbeResultOptions,
  NormalizeAudioProbeRecordOptions,
} from '../audio-probe-result.ts';
export {
  isAudioProbeSupportedDevice,
  isHostSystemAudioProbeDevice,
} from '../audio-probe-support.ts';
export type { PlatformPlugin } from '../platform-plugin.ts';
export { assertCommandPlatformExecution } from '../command-platform-execution.ts';
export type { CommandPlatformExecution } from '../command-platform-execution.ts';
export { AsyncCleanupStack, PendingTransferGuard } from '../async-lifecycle.ts';
export {
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
  runtimeOwnerKey,
  sameRuntimeOwner,
} from '../platform-runtime.ts';
export type {
  BoundDeviceRuntime,
  DeviceBinding,
  DeviceBindingIntent,
  DeviceBindingRequest,
  DeviceRuntimeGateway,
  DeviceRuntimeOwner,
  ResourceOwnershipFence,
  RuntimeDeviceShape,
  RuntimeFacts,
  RuntimeOperationFact,
  RuntimeOperationKey,
  RuntimeOperationUnavailability,
  RuntimeOwnerRef,
  RuntimePlatformModule,
  RuntimeProviderMode,
  RuntimeUse,
  RuntimeUseDeclaration,
} from '../platform-runtime.ts';
export {
  createUnavailablePlatformRuntimeBinding,
  createUnavailablePlatformRuntimeFacts,
  createUnavailablePlatformRuntimeOwner,
} from '../platform-runtime-unavailable.ts';
export type { UnavailablePlatformRuntimeFacts } from '../platform-runtime-unavailable.ts';
export type {
  DurableDescriptorBodyDecodeOutcome,
  DurableDescriptorCodec,
  DurableEnvelopeDecodeOutcome,
  DurableResourceEnvelope,
  DurableResourceLifecycleState,
  EncodedDurableDescriptor,
} from '../durable-resource-envelope.ts';
export { isConfirmedCleanup } from '../durable-resource.ts';
export type {
  CleanupOutcome,
  CleanupPendingReason,
  FinishOutcome,
  LiveResourceHandle,
  ReattachOutcome,
  ResourceUnreattachableReason,
} from '../durable-resource.ts';
export { APP_LOG_RESOURCE_KIND } from '../app-log-runtime.ts';
export type {
  AppLogBackgroundProcess,
  AppLogBackgroundProcessRequest,
  AppLogCompletion,
  AppLogFailure,
  AppLogLiveHandle,
  AppLogLiveSnapshot,
  AppLogLiveState,
  AppLogOutputSink,
  AppLogProcessMarker,
  AppLogProcessMarkerReadOutcome,
  AppLogProcessOwnership,
  AppLogProcessCommand,
  AppLogProcessStart,
  AppLogProcessTransport,
  AppLogRuntimeHost,
  AppLogRuntimeOperations,
  AppLogSessionArtifacts,
  AppLogStartInput,
  AppLogStartResult,
} from '../app-log-runtime.ts';
export type { NetworkDump, NetworkDumpParserOptions } from '../network-traffic.ts';
export type {
  NetworkAppLogRead,
  NetworkAppLogSnapshot,
  NetworkDumpInput,
  NetworkDumpResult,
  NetworkProviderDump,
  NetworkProviderDumpResult,
  NetworkProviderEntry,
  NetworkRuntimeHost,
  NetworkRuntimeOperations,
  NetworkTransport,
} from '../network-runtime.ts';
export { SCREEN_RECORDING_RESOURCE_KIND } from '../screen-recording-runtime.ts';
export type {
  RecordingGestureEvent,
  ScreenRecordingChunk,
  ScreenRecordingCompletion,
  ScreenRecordingLiveHandle,
  ScreenRecordingLiveSnapshot,
  ScreenRecordingReattachInput,
  ScreenRecordingRuntimeOperations,
  ScreenRecordingStartInput,
  ScreenRecordingStartResult,
} from '../screen-recording-runtime.ts';
export type {
  AndroidScreenRecordingHost,
  AndroidScreenRecordingManifestReadOutcome,
  AndroidScreenRecordingProcessIdentity,
  AndroidScreenRecordingProcessOwnership,
  AndroidScreenRecordingStopOutcome,
  AndroidScreenRecordingTransport,
  AppleScreenRecordingAvailability,
  AppleScreenRecordingClockAnchor,
  AppleScreenRecordingHost,
  AppleScreenRecordingRunnerRequest,
  AppleScreenRecordingRunnerResult,
  HarmonyScreenRecordingHost,
  ScreenRecordingBackgroundProcess,
  ScreenRecordingFinalizer,
  ScreenRecordingOutputHost,
  ScreenRecordingRuntimeHost,
  WebScreenRecordingHost,
  WebScreenRecordingTransport,
} from '../screen-recording-runtime-host.ts';
export {
  screenRecordingAdmissionUse,
  screenRecordingRuntimePlanUses,
  screenRecordingStartUse,
  screenRecordingRecoveryUse,
  resolveScreenRecordingRuntimePlan,
} from '../screen-recording-runtime-plan.ts';
export type {
  ScreenRecordingRuntimePlan,
  ScreenRecordingRuntimePlanInput,
} from '../screen-recording-runtime-plan.ts';
export { assertRecordRuntimeExecution } from '../record-runtime-cutover.ts';
export {
  networkAdmissionUse,
  networkDumpUse,
  resolveNetworkRuntimePlan,
} from '../network-runtime-plan.ts';
export type {
  NetworkRuntimeAction,
  NetworkRuntimePlan,
  NetworkRuntimePlanInput,
} from '../network-runtime-plan.ts';
export type {
  AppInventoryRuntimeHost,
  AppInventoryRuntimeOperations,
  InstalledAppInfo,
  ListAppsInput,
} from '../app-inventory-runtime.ts';
export { appsRuntimeUse, defineUse } from '../platform-runtime-operations.ts';
export type {
  PlatformRuntimeHost,
  PlatformRuntimeModule,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  PlatformRuntimeProviderModule,
} from '../platform-runtime-operations.ts';
export {
  bootTargetHeadlessUse,
  bootTargetUse,
  deviceBootRuntimeUses,
  resolveDeviceReadinessRuntimePlan,
  appStateRuntimeUses,
  appStateUse,
} from '../platform-runtime-operations.ts';
export type { DeviceReadinessRuntimePlan } from '../platform-runtime-operations.ts';
export type {
  AppStateRuntimeCommand,
  AppStateRuntimeCommandResult,
  AppStateRuntimeHost,
  AppStateRuntimeOperations,
  AppStateRuntimeResult,
} from '../app-state-runtime.ts';
export type {
  DeviceReadinessRuntimeHost,
  DeviceReadinessRuntimeOperations,
  EnsureReadyInput,
} from '../device-readiness-runtime.ts';
export {
  appLogAdmissionUse,
  appLogRuntimePlanUses,
  resolveLogsRuntimePlan,
} from '../logs-runtime-plan.ts';
export type { LogsRuntimePlan, LogsRuntimePlanInput } from '../logs-runtime-plan.ts';
export type { PlatformGatedProviderResolverKey } from '../platform-providers.ts';
export type { RunnerLogicalLeaseContext } from '../runner-lease-context.ts';
export type {
  AppleToolHost,
  AppleToolRequest,
  AppleXcrunTool,
  HostCommandRequest,
  HostCommandResult,
  HostCommandRunner,
  HostToolchainPreparer,
  HostOperatingSystem,
  HostTemporaryTextFile,
  ManagedProcessIdentity,
  ManagedProcessOwnership,
  DeviceInventoryFileHost,
  DeviceInventoryHost,
  DeviceInventoryHostByFamily,
  DeviceInventoryHostFor,
  DeviceObservationSink,
  NativeAssetResolver,
  PlatformDiagnosticEvent,
  PlatformDiagnosticSink,
  PlatformProgressSink,
  PlatformProgressUpdate,
  ResolvedNativeAsset,
  PlatformRequestScope,
} from '../platform-runtime-host.ts';
export { createPlatformModuleRegistry, inventoryUse } from '../platform-module.ts';
export type {
  ComposedDeviceInventoryGateways,
  DeviceInventoryDiscovery,
  DeviceInventoryGateway,
  DeviceInventorySource,
  InventoryPlatformModule,
  InventoryUse,
  PlatformModuleMetadata,
  PlatformModuleRegistry,
  ProviderAwareDeviceInventoryGateway,
} from '../platform-module.ts';
