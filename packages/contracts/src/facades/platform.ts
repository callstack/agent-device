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
  ANDROID_CAPTURE_FAILURE_REASONS,
  ANDROID_CONTENT_RECOVERY_REASONS,
  isAndroidContentRecoveryReason,
  isUnreadableCaptureContentError,
  isAndroidCaptureFailureReason,
  readAndroidCaptureFailureReason,
} from '../android-snapshot-quality.ts';
export type {
  AndroidCaptureFailureReason,
  AndroidContentRecoveryReason,
} from '../android-snapshot-quality.ts';
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
export type {
  AndroidAppDeploymentExecutor,
  AppDeploymentInput,
  AppDeploymentResult,
  AppDeploymentRuntimeOperations,
  AppDeploymentSource,
  AppleAppDeploymentExecutor,
  DeployMaterializedAppInput,
  MaterializedAppSource,
  MaterializeAppSourceInput,
  PushNotificationInput,
  PushNotificationResult,
} from '../app-deployment-runtime.ts';
export {
  deployAppUse,
  readyMaterializeAndDeployAppUse,
  readySendPushNotificationUse,
} from '../app-deployment-runtime-plan.ts';
export { assertCommandPlatformExecution } from '../command-platform-execution.ts';
export type { CommandPlatformExecution } from '../command-platform-execution.ts';
export { AsyncCleanupStack, PendingTransferGuard } from '../async-lifecycle.ts';
export {
  resetStartupRecoveryFencesForTests,
  runStartupRecoveryFence,
  waitForStartupRecoveryFence,
} from '../startup-recovery-fence.ts';
export {
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
  runtimeOwnerKey,
  sameRuntimeOwner,
  whenAdmitted,
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
export {
  appsRuntimeUse,
  captureSnapshotUse,
  defineUse,
  resolveScreenshotRuntimePlan,
  resolveSelectorCaptureRuntimePlan,
  resolveSnapshotRuntimePlan,
  screenshotRuntimePlanUses,
  selectorCaptureRuntimePlanUses,
  selectorTextCaptureRuntimePlanUses,
  snapshotRuntimePlanUses,
  waitSelectorCaptureRuntimePlanUses,
  findRuntimePlanUses,
  focusRuntimeUse,
  gestureRuntimePlanUses,
  resolveGestureRuntimePlan,
  resolveScrollRuntimePlan,
  scrollRuntimePlanUses,
  swipeRuntimePlanUses,
  typeTextRuntimeUse,
  viewportRuntimeUse,
  backRuntimeUse,
  homeRuntimeUse,
  orientationRuntimeUse,
  tvRemoteRuntimeUse,
  keyboardRuntimePlanUses,
  keyboardStatusUse,
  keyboardDismissUse,
  keyboardEnterUse,
} from '../platform-runtime-operations.ts';
export type {
  GestureRuntimePlan,
  ScreenshotRuntimePlan,
  ScrollRuntimePlan,
  SelectorCaptureRuntimeIntent,
  SelectorCaptureRuntimePlan,
  SnapshotRuntimePlan,
} from '../platform-runtime-operations.ts';
export { waitObservesDevice } from '../wait-runtime-plan.ts';
export type { WaitRuntimeTarget } from '../wait-runtime-plan.ts';
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
  capturedFillUse,
  capturedHoverUse,
  capturedLongPressUse,
  capturedTapUse,
  clickRuntimeUses,
  deviceBootRuntimeUses,
  fillPointUse,
  fillRuntimeUses,
  hoverPointUse,
  hoverRuntimeUses,
  longPressPointUse,
  longPressRuntimeUses,
  pressRuntimeUses,
  resolveDeviceReadinessRuntimePlan,
  resolveTouchRuntimePlan,
  appStateRuntimeUses,
  appStateUse,
  shutdownTargetUse,
  tapPointUse,
} from '../platform-runtime-operations.ts';
export type {
  DeviceReadinessRuntimePlan,
  TouchRuntimePlan,
} from '../platform-runtime-operations.ts';
export {
  bindLocalScreenshotInteractor,
  bindProviderScreenshotInteractor,
  screenshotRuntimeOperationFacts,
} from '../screenshot-runtime.ts';
export type {
  CaptureScreenshotInput,
  ScreenshotOptions,
  ScreenshotRuntimeExecution,
  ScreenshotRuntimeOperations,
  ScreenshotRuntimeOperationFacts,
} from '../screenshot-runtime.ts';
export {
  bindLocalSnapshotInteractor,
  bindProviderSnapshotInteractor,
  captureSnapshotSignal,
  snapshotRuntimeOperationFacts,
} from '../snapshot-runtime.ts';
export { selectorObservationRuntimeOperationFacts } from '../selector-observation-runtime.ts';
export type {
  FindSelectorInput,
  FindSelectorResult,
  FindSelectorRuntimeOperations,
  FindTextInput,
  FindTextResult,
  FindTextRuntimeOperations,
  SelectorObservationRuntimeOperationFacts,
  SelectorObservationRuntimeOperations,
  SelectorObservationResult,
} from '../selector-observation-runtime.ts';
export type {
  CaptureSnapshotInput,
  LocalSnapshotInteractorResolver,
  ProviderSnapshotInteractorResolver,
  SnapshotRuntimeExecution,
  SnapshotRuntimeHost,
  SnapshotRuntimeOperations,
  SnapshotRuntimeOperationFacts,
  SnapshotResult,
} from '../snapshot-runtime.ts';
export {
  bindLocalFocusInteractor,
  bindProviderFocusInteractor,
  focusRuntimeOperationFacts,
} from '../focus-runtime.ts';
export type {
  FocusPointInput,
  FocusRuntimeOperationFacts,
  FocusRuntimeOperations,
  LocalFocusInteractorResolver,
  ProviderFocusInteractorResolver,
} from '../focus-runtime.ts';
export {
  bindLocalTypeTextInteractor,
  bindProviderTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '../type-text-runtime.ts';
export {
  bindLocalTouchInteractor,
  bindProviderTouchInteractor,
  HOVER_UNAVAILABLE_HINT,
  pressJitter,
  touchRuntimeOperationFacts,
} from '../touch-runtime.ts';
export type {
  FillPointInput,
  FillRefInput,
  HoverPointInput,
  HoverRefInput,
  LongPressPointInput,
  TapElementSelectorInput,
  TapPointInput,
  TapRefInput,
  TouchRuntimeOperationFacts,
  TouchRuntimeOperations,
} from '../touch-runtime.ts';
export type {
  LocalTypeTextInteractorResolver,
  ProviderTypeTextInteractorResolver,
  TypeTextInput,
  TypeTextRuntimeOperationFacts,
  TypeTextRuntimeOperations,
} from '../type-text-runtime.ts';
export {
  bindLocalBackInteractor,
  bindProviderBackInteractor,
  backRuntimeOperationFacts,
} from '../back-runtime.ts';
export type {
  BackInput,
  BackRuntimeOperationFacts,
  BackRuntimeOperations,
  LocalBackInteractorResolver,
  ProviderBackInteractorResolver,
} from '../back-runtime.ts';
export {
  bindLocalHomeInteractor,
  bindProviderHomeInteractor,
  homeRuntimeOperationFacts,
} from '../home-runtime.ts';
export type {
  HomeInput,
  HomeRuntimeOperationFacts,
  HomeRuntimeOperations,
  LocalHomeInteractorResolver,
  ProviderHomeInteractorResolver,
} from '../home-runtime.ts';
export {
  bindLocalOrientationInteractor,
  bindProviderOrientationInteractor,
  orientationRuntimeOperationFacts,
} from '../orientation-runtime.ts';
export type {
  LocalOrientationInteractorResolver,
  OrientationRuntimeOperationFacts,
  OrientationRuntimeOperations,
  ProviderOrientationInteractorResolver,
  SetOrientationInput,
  SetOrientationResult,
} from '../orientation-runtime.ts';
export {
  bindLocalTvRemoteInteractor,
  bindProviderTvRemoteInteractor,
  tvRemoteRuntimeOperationFacts,
} from '../tv-remote-runtime.ts';
export type {
  LocalTvRemoteInteractorResolver,
  ProviderTvRemoteInteractorResolver,
  TvRemoteInput,
  TvRemoteRuntimeOperationFacts,
  TvRemoteRuntimeOperations,
} from '../tv-remote-runtime.ts';
export {
  bindLocalKeyboardStatusInteractor,
  bindProviderKeyboardStatusInteractor,
  bindLocalKeyboardDismissInteractor,
  bindProviderKeyboardDismissInteractor,
  bindLocalKeyboardEnterInteractor,
  bindProviderKeyboardEnterInteractor,
  keyboardRuntimeOperationFacts,
} from '../keyboard-runtime.ts';
export type {
  KeyboardActionInput,
  KeyboardDismissResult,
  KeyboardDismissRuntimeOperations,
  KeyboardEnterResult,
  KeyboardEnterRuntimeOperations,
  KeyboardRuntimeOperationFacts,
  KeyboardRuntimeOperations,
  KeyboardStatusResult,
  KeyboardStatusRuntimeOperations,
  LocalKeyboardInteractorResolver,
  ProviderKeyboardInteractorResolver,
} from '../keyboard-runtime.ts';
export { APPLE_MULTI_TOUCH_UNSUPPORTED_HINTS } from '../apple-multitouch-support.ts';
export { viewportRuntimeOperationFacts } from '../viewport-runtime.ts';
export type {
  SetViewportInput,
  ViewportRuntimeOperationFacts,
  ViewportRuntimeOperations,
} from '../viewport-runtime.ts';
export {
  bindElementTextRuntime,
  elementTextRead,
  elementTextRuntimeOperationFacts,
} from '../element-text-runtime.ts';
export type {
  ElementTextReadOutcome,
  ElementTextInteractorResolver,
  ElementTextRuntimeOperationFacts,
  ElementTextRuntimeOperations,
  ElementTextUnreadableReason,
  ReadTextAtPointInput,
} from '../element-text-runtime.ts';
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
export type {
  DeviceShutdownCloseCapability,
  DeviceShutdownFamilyRuntime,
  DeviceShutdownRuntimeDependencies,
  DeviceShutdownRuntimeHost,
  DeviceShutdownRuntimeLoaders,
  DeviceShutdownRuntimeOperations,
} from '../device-shutdown-runtime.ts';
export type {
  ApplicationLifecycleResourceLifecycle,
  ApplicationLifecycleExecution,
  ApplicationLifecycleProviderInteractorResolver,
  AndroidApplicationTools,
  AppleApplicationTools,
  LocalApplicationInteractorHost,
  ApplicationLifecycleRuntimeOperations,
  CloseApplicationFinalizationResult,
  CloseApplicationFinalizationInput,
  CloseApplicationInput,
  OpenApplicationInput,
  OpenApplicationOutcome,
  OpenApplicationPreparationInput,
  OpenApplicationTiming,
  OpenTargetResolution,
  OpenTargetResolutionInput,
  PrepareAppleRunnerInput,
  PrepareAppleRunnerResult,
  RuntimeHintsApplicationInput,
  RuntimeHintValues,
} from '../application-lifecycle-runtime.ts';
export {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
  hasRuntimeTransportHintValues,
} from '../application-lifecycle-runtime.ts';
export type { ApplicationLifecycleOperationFacts } from '../application-lifecycle-runtime.ts';
export {
  bindDirectApplicationLifecycle,
  bindLocalApplicationLifecycleInteractor,
  bindProviderApplicationLifecycleInteractor,
  followUpRuntimeLaunchUrl,
  invokeApplicationClose,
  invokeApplicationOpen,
} from '../application-lifecycle-interaction.ts';
export type {
  ApplicationLifecycleInteractorBinding,
  DirectApplicationLifecycleParams,
  DirectOpenTargetIdentity,
  LocalApplicationLifecycleInteractorResolver,
} from '../application-lifecycle-interaction.ts';
export {
  clearRuntimeHintsRuntimeUse,
  closeApplicationRuntimePlanUses,
  closeApplicationRuntimeUse,
  closeApplicationWithRuntimeHintClearUse,
  configureProviderPortReverseRuntimeUse,
  finalizeApplicationCloseRuntimeUse,
  finalizeApplicationCloseWithRuntimeHintClearUse,
  openApplicationRuntimeUse,
  openApplicationWithRuntimeHintApplyAndClearUse,
  openApplicationWithRuntimeHintApplyUse,
  openApplicationRuntimePlanUses,
  openApplicationWithRuntimeHintClearUse,
  prepareAppleRunnerRuntimeUse,
  resolveOpenApplicationRuntimePlan,
  runtimeCommandRuntimePlanUses,
} from '../application-lifecycle-runtime-plan.ts';
export type { OpenApplicationRuntimePlan } from '../application-lifecycle-runtime-plan.ts';
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
  AndroidToolHost,
  HostCommandRequest,
  HostCommandResult,
  HostCommandRunner,
  HostToolchainPreparer,
  HostOperatingSystem,
  HostTemporaryTextFile,
  ManagedProcessIdentity,
  ManagedProcessOwnership,
  OwnedProcessRecord,
  OwnedProcessRecordScope,
  OwnedProcessRecordWriter,
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
