/**
 * Named Android mechanics surface for root/runtime consumers.
 *
 * The package root remains the metadata and lazy-runtime façade. This facet is the explicit
 * implementation seam for selected Android use; host-bound adb wiring is supplied separately by
 * the root composition module.
 */
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
  type AndroidTouchInjector,
} from './adb-executor.ts';
export {
  androidAdbForwardsDeviceExitStatus,
  resetAndroidAdbShellProtocolProbes,
} from './adb-shell-protocol.ts';
export { isClipboardShellUnsupported, runAndroidAdb, sleep } from './adb.ts';
export { handleAndroidAlert, type AndroidAlertResult } from './alert.ts';
export {
  classifyAndroidAlertIdentifier,
  findAndroidAlertCandidate,
  isAndroidPermissionPackage,
  type AndroidAlertButton,
  type AndroidAlertCandidate,
  type AndroidAlertInfo,
} from './alert-detection.ts';
export {
  forceStopAndroidAppWithAdb,
  openAndroidAppWithAdb,
  type AndroidOpenAppWithAdbOptions,
} from './app-control.ts';
export {
  androidAppsDiscoveryHint,
  inferAndroidAppName,
  resolveAndroidApp,
  withAndroidAppResolutionCacheInvalidated,
  type AndroidAppResolution,
} from './app-deployment-resolution.ts';
export { installAndroidInstallablePath } from './app-deployment.ts';
export type {
  AndroidAppListFilter,
  AndroidAppListOptions,
  AndroidAppListTarget,
} from './app-helpers.ts';
export async function listAndroidAppsWithAdb(
  ...args: Parameters<typeof import('./app-helpers.ts').listAndroidAppsWithAdb>
): Promise<Awaited<ReturnType<typeof import('./app-helpers.ts').listAndroidAppsWithAdb>>> {
  const { listAndroidAppsWithAdb: load } = await import('./app-helpers.ts');
  return await load(...args);
}
export {
  closeAndroidApp,
  isAmStartError,
  listAndroidApps,
  openAndroidApp,
  openAndroidDevice,
  parseAndroidLaunchComponent,
  type OpenAndroidAppOptions,
} from './app-lifecycle.ts';
export {
  ANDROID_FOCUSED_WINDOW_MARKER,
  ANDROID_FOCUS_MARKERS,
  parseAndroidLaunchablePackages,
  parseAndroidUserInstalledPackages,
  readAndroidBlockingDialogFocus,
  type AndroidBlockingDialogFocus,
  type AndroidBlockingDialogRead,
} from './app-parsers.ts';
export {
  dismissAndroidKeyboard,
  dismissAndroidKeyboardWithAdb,
  getAndroidKeyboardState,
  getAndroidKeyboardStatusWithAdb,
  readAndroidClipboardText,
  readAndroidClipboardWithAdb,
  writeAndroidClipboardText,
  writeAndroidClipboardWithAdb,
  type AndroidKeyboardDismissResult,
  type AndroidKeyboardState,
} from './device-input-state.ts';
export { androidDeviceChecks, androidToolchainCheck } from './doctor.ts';
export {
  ensureAndroidEmulatorBooted,
  waitForAndroidBoot,
  type AndroidEmulatorLifecycleDependencies,
} from './emulator-lifecycle.ts';
export {
  androidFillFailureDetails,
  androidFillFailureMessage,
  buildAndroidFillUnconfirmedVerification,
  completeAndroidFillVerification,
  readAndroidFillTargetBeforeMutation,
  readAndroidTextAtPoint,
  readAndroidTextAtPointInHierarchy,
  verifyAndroidFilledText,
  verifyAndroidFilledTextInHierarchy,
  type AndroidFillVerification,
} from './fill-verification.ts';
export { validateAndroidGestureViewport } from './gesture-viewport.ts';
export {
  inspectInstalledAndroidHelper,
  makeEnsureAndroidHelperInstalled,
  resolveAndroidHelperArtifact,
  verifyAndroidHelperApkChecksum,
  type AndroidHelperInstallDecision,
  type InstalledAndroidHelperState,
} from './helper-package-install.ts';
export { activateAndroidTestIme } from './ime-activation.ts';
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
} from './ime-helper.ts';
export {
  ANDROID_TEST_IME_SETTINGS_KEYS,
  listAndroidAdbSerialsQuick,
  readAndroidDefaultInputMethod,
  restoreAndroidTestIme,
  restoreOrphanedAndroidTestImeOnDaemonStartup,
  isAndroidTestImeActive,
  resetAndroidTestImeActivationCacheForTests,
  setAndroidTestImeActiveForTests,
} from './ime-lifecycle.ts';
export {
  clearAndroidTestImeRecoveryMarker,
  readAndroidTestImeRecoveryMarkers,
  writeAndroidTestImeRecoveryMarker,
} from './ime-recovery-marker.ts';
export {
  appSwitcherAndroid,
  backAndroid,
  focusAndroid,
  getAndroidScreenSize,
  homeAndroid,
  longPressAndroid,
  pressAndroid,
  pressAndroidEnter,
  pressAndroidTvRemote,
  scrollAndroid,
  setAndroidOrientation,
} from './input-actions.ts';
export {
  prepareAndroidInstallArtifact,
  type PreparedAndroidInstallArtifact,
} from './install-artifact.ts';
export {
  parseInstrumentationRecords,
  readAndroidHelperManifestInteger,
  readAndroidHelperManifestLiteral,
  readInstrumentationResultBoolean,
  readInstrumentationResultNumber,
} from './instrumentation-helper.ts';
export type { AndroidLogcatCaptureOptions } from './logcat.ts';
export async function captureAndroidLogcatWithAdb(
  ...args: Parameters<typeof import('./logcat.ts').captureAndroidLogcatWithAdb>
): Promise<Awaited<ReturnType<typeof import('./logcat.ts').captureAndroidLogcatWithAdb>>> {
  const { captureAndroidLogcatWithAdb: load } = await import('./logcat.ts');
  return await load(...args);
}
export { resolveAndroidArchivePackageName } from './manifest.ts';
export { pushAndroidNotification } from './notifications.ts';
export {
  classifyAndroidAppTarget,
  formatAndroidInstalledPackageRequiredMessage,
  type AndroidAppTargetKind,
} from './open-target.ts';
export {
  resetAndroidFramePerfStats,
  sampleAndroidFramePerf,
  type AndroidFramePerfOptions,
  type AndroidFramePerfSample,
} from './perf-frame.ts';
export type {
  AndroidNativePerfStartResult,
  AndroidNativePerfStopResult,
} from './perf-native-types.ts';
export {
  cleanupAndroidNativePerfSession,
  startAndroidPerfettoTrace,
  startAndroidSimpleperfProfile,
  stopAndroidPerfettoTrace,
  stopAndroidSimpleperfProfile,
  writeAndroidSimpleperfReport,
  type AndroidNativePerfSession,
} from './perf-native.ts';
export {
  captureAndroidHeapSnapshot,
  sampleAndroidMemoryPerf,
  type AndroidHeapSnapshotResult,
  type AndroidMemoryConsumer,
  type AndroidMemoryPerfSample,
  type AndroidPerfOptions,
} from './perf.ts';
export {
  annotateAndroidNativePerfError,
  buildAndroidNativeToolUnavailableHint,
} from './perf-native-errors.ts';
export { androidRevokedPermissionWarning, setAndroidPermission } from './settings-permission.ts';
export { setAndroidSetting } from './settings.ts';
export {
  androidCaptureFailureReasonDetail,
  androidCaptureFailureReasonFromExitCode,
  androidCaptureFailureReasonFromHelperResult,
} from './snapshot-capture-failure-reason.ts';
export {
  androidSnapshotPublicationInput,
  createAndroidSnapshotCapture,
  type AndroidSnapshotCapture,
  type AndroidSnapshotPublicationInput,
} from './snapshot-capture.ts';
export { buildAndroidSnapshotClickabilityEvidence } from './snapshot-clickability.ts';
export {
  classifyAndroidHelperContent,
  type AndroidHelperContentRecoveryDecision,
} from './snapshot-content-recovery.ts';
export {
  parseAndroidSnapshotHelperManifest,
  readAndroidSnapshotHelperInstallOptions,
  type AndroidSnapshotHelperInstallOptions,
} from './snapshot-helper-artifact.ts';
export {
  buildAndroidSnapshotHelperArgs,
  buildAndroidSnapshotHelperCaptureOptions,
  captureAndroidSnapshotWithHelper,
  parseAndroidSnapshotHelperOutput,
  resolveAndroidSnapshotHelperCaptureOptions,
  type AndroidSnapshotHelperResolvedCaptureOptions,
} from './snapshot-helper-capture.ts';
export {
  ensureAndroidSnapshotHelper,
  forgetAndroidSnapshotHelperInstall,
  getAndroidSnapshotHelperSessionDeviceKey,
  isAndroidSnapshotHelperRetirementUnconfirmedError,
  parseAndroidSnapshotHelperManifest as parseAndroidHelperManifest,
  resetAndroidSnapshotHelperSessions,
  stopAndroidSnapshotHelperSession,
  stopAndroidSnapshotHelperSessionForDevice,
  captureAndroidSnapshotWithHelperSession,
  type AndroidSnapshotHelperArtifact,
  type AndroidSnapshotHelperInstallPolicy,
  type AndroidSnapshotHelperInstallResult,
  type AndroidSnapshotHelperOutput,
} from './snapshot-helper.ts';
export { resetAndroidSnapshotHelperInstallCache } from './snapshot-helper-install.ts';
export { runAndroidSnapshotHelperSessionTouchCommand } from './snapshot-helper-session.ts';
export {
  resetAndroidSnapshotHelperRuntime,
  retireAndroidSnapshotHelperAfterContentFailure,
} from './snapshot-helper-runtime.ts';
export { snapshotAndroid, type AndroidSnapshotOptions } from './snapshot.ts';
export { screenshotAndroid, type AndroidScreenshotOptions } from './screenshot.ts';
export {
  ANDROID_SNAPSHOT_PRESENTATION_DEFAULT_DEADLINE_MS,
  AndroidSnapshotPresentationFailure,
  createAndroidSnapshotPresentationBudget,
  createAndroidSnapshotPresentationNode,
  isAndroidSnapshotPresentationFailure,
  validateAndroidRegularPresentation,
  type AndroidSnapshotPresentationAnalysis,
  type AndroidSnapshotPresentationBudget,
  type AndroidSnapshotPresentationFailureDetails,
  type AndroidSnapshotPresentationFailurePhase,
  type AndroidSnapshotPresentationNode,
  type AndroidSnapshotPresentationOptions,
} from './snapshot-presentation.ts';
export type {
  AndroidHelperSessionScope,
  AndroidSnapshotHelperCaptureOptions,
  AndroidSnapshotHelperManifest,
  AndroidSnapshotHelperMetadata,
  AndroidSnapshotHelperTransport,
} from './snapshot-helper-types.ts';
export type {
  AndroidImeHelperArtifact,
  AndroidImeHelperManifest,
} from '@agent-device/contracts/android-helper-artifacts';
export type { AndroidAdbEnvironment, AndroidAdbFileHost, AndroidAdbHost } from './adb-host.ts';
export { ensureAndroidSdkPathConfigured } from './sdk.ts';
export { fillAndroid, typeAndroid } from './text-input.ts';
export { executeAndroidTouchPlan, readAndroidGestureViewport } from './touch-executor.ts';
export {
  ANDROID_TOUCH_PLAN_PROTOCOL,
  executeAndroidTouchHelperPlan,
  normalizeAndroidTouchHelperGestureRequest,
  readAndroidTouchHelperFinalRecord,
  readAndroidTouchHelperViewport,
} from './touch-helper.ts';
export {
  lowerAndroidTouchPlan,
  type AndroidLongPressTouchPlan,
  type AndroidLoweredTouchPlan,
  type AndroidTouchPlan,
} from './touch-plan.ts';
export {
  androidUiNodes,
  buildUiHierarchySnapshot,
  parseUiHierarchyTree,
  type AndroidBuiltSnapshot,
  type AndroidSnapshotAnalysis,
  type AndroidUiHierarchy,
  type AndroidUiHierarchySnapshotOptions,
  type AndroidUiNodeMetadata,
} from './ui-hierarchy.ts';
export {
  createAndroidWindowDumpReader,
  getAndroidAppState,
  getAndroidBlockingDialogObservation,
  resetAndroidWindowDumpFocusMemoForTests,
  type AndroidBlockingDialogObservation,
  type AndroidWindowDumpReader,
} from './window-state.ts';
