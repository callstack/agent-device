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
export { publishDaemonRegistration } from './daemon-registration-fixtures.ts';
export { deviceClaimFilePath } from './device-claim-fixtures.ts';
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
export {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from './dispatch-disclosure.fixtures.ts';
export { restoreEnv } from './env.ts';
export {
  eagerClosureGraphOf,
  eagerClosureOf,
  eagerlyEvaluatedModules,
  statementTextsOf,
  topLevelStatementCount,
  topLevelStatementWeightsOf,
  type SourceTreeReader,
} from './eager-import-closure-fixtures.ts';
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
export {
  ELEMENT14_DISTINCT_SUBTREE_NODES,
  EQUIVALENT_WRAPPER_CHAIN_NODES,
  INDEXED_PARITY_POLICY_NODES,
  RN_TEXT_ECHO_AUTHORED_CHILD_NODES,
  RN_TEXT_ECHO_DISTINCT_SUBTREE_NODES,
  RN_TEXT_ECHO_NODES,
  RN_TEXT_ECHO_OFFSET_RECT_NODES,
  TWO_ACTIONABLE_WRAPPER_CHAIN_NODES,
  UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES,
} from './interaction-targeting.fixtures.ts';
export {
  KEYBOARD_COVERED_BAND_RECT,
  KEYBOARD_COVERED_TAB_BAR_RECT,
  keyboardCoveredTabBarSnapshot,
} from './keyboard-occlusion.fixtures.ts';
export {
  LANE_ENVELOPE_SCHEMA_VERSION,
  laneEnvelope,
  type LaneEnvelope,
  type LaneEnvelopeInput,
  type LaneResult,
} from './lane-envelope.ts';
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
  selectV2Plugin,
  v2RegistrationSource,
  webDriverPluginSource,
  writePlugin,
} from './plugin.fixtures.ts';
export {
  formatRef,
  type GeneratedRef,
  PROPERTY_RUNS_SMALL,
  rawSnapshotNodesArb,
  refArb,
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

export {
  writeFakeMetroNpx,
  findFreeMetroPort,
  stopTestMetroProcess,
} from './metro-process.fixtures.ts';

export { readMetroSessionFixture, writeMetroSessionFixture } from './metro-session.fixtures.ts';
