// The one entry of @agent-device/test-kit: every shared test helper, named explicitly. Importing it
// loads every module below; each is free of import-time side effects. Tests import helpers from
// '@agent-device/test-kit', never from a file path.

export { assertRejectsAppError, assertThrowsAppError } from './app-error.ts';
export { createTestAppLogLiveHandle } from './app-log-live-handle.ts';
export {
  BOUNDARY_COMMAND_CLASSES,
  BOUNDARY_FAULT_MATRIX,
  BOUNDARY_FAULTS,
  type BoundaryCommandClass,
  type BoundaryCoverage,
  type BoundaryFault,
  type BoundaryFaultMatrix,
  type BoundaryInvariant,
} from './boundary-fault-matrix.ts';
export { withNoColor, withNoColorAsync } from './color.ts';
export {
  ANDROID_DEVICE,
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  IOS_DEVICE,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from './device-fixtures.ts';
export { restoreEnv } from './env.ts';
export {
  type FilesystemBoundaryFixture,
  type FilesystemBoundaryOwner,
  type FilesystemErrno,
  type FilesystemFaultPoint,
  registerFilesystemBoundaryMatrix,
} from './filesystem-boundary-faults.ts';
export {
  type CommandSpawnOutcome,
  type CommandSpawnRecorder,
  recordCommandSpawns,
  type RecordedSpawn,
  withMockedPlatform,
} from './host-execution.ts';
export { pinOwnProcessStartTime } from './host-process-mock.ts';
export { spawnLegacyDaemonFixture } from './legacy-daemon-fixture.ts';
export {
  closeLoopbackServer,
  listenOnLoopback,
  type LoopbackServer,
  type SkippableTestContext,
  skipWhenLoopbackUnavailable,
  supportsLoopbackBind,
  trackLoopbackSockets,
  waitForHttpOk,
} from './loopback.ts';
export {
  pluginHome,
  registrationSource,
  selectPlugin,
  selectPluginManifest,
  webDriverPluginSource,
  writePlugin,
} from './plugin.fixtures.ts';
export {
  formatRef,
  type GeneratedRef,
  PROPERTY_RUNS_SMALL,
  rawSnapshotNodesArb,
  refArb,
  replayScriptArb,
} from './property-arbitraries.ts';
export {
  createUnavailableRuntimeFactsForTest,
  unavailableApplicationLifecycleOperationFacts,
  unavailableDeploymentSnapshotAndShutdownOperationFacts,
} from './runtime-operation-facts.ts';
export { buildNodes } from './snapshot-builders.ts';
export {
  bottomTabsRealCaptureFixture,
  recordArticleEvidence,
} from './target-classification-fixtures.ts';
export { mkdtempForTest, mkdtempForTestSync } from './tmp-dir.ts';
export { likelyPlayableWebmContainer } from './video-fixtures.ts';
export {
  installFakeManagedAgentBrowser,
  withNodeRuntime,
  writeFakeManagedAgentBrowserPackage,
} from './web-managed-agent-browser.ts';
