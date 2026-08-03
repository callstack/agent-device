// R11 package-boundaries fires on every bypass and holds on the one exception.
// Necessary for the same reason as zone-policy.test.ts: the real tree is clean,
// so a rule that stopped matching would look exactly like a rule being obeyed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkPackageBoundaries,
  checkPackageInternalSites,
  checkRootSites,
  readFacadeExports,
  readNamedExports,
  readWorkspacePackages,
  rootExternalDependencyRanges,
  rootWorkspaceDependencyNames,
  specifierSites,
  type WorkspacePackage,
} from './package-boundaries.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const kernel: WorkspacePackage = {
  dir: 'packages/kernel',
  name: '@agent-device/kernel',
  exportTargets: new Map([
    ['@agent-device/kernel/errors', 'packages/kernel/src/errors.ts'],
    ['@agent-device/kernel/device', 'packages/kernel/src/device.ts'],
  ]),
  workspaceDependencies: new Set(),
  externalDependencies: new Map(),
};

const contracts: WorkspacePackage = {
  dir: 'packages/contracts',
  name: '@agent-device/contracts',
  exportTargets: new Map([
    ['@agent-device/contracts/interaction', 'packages/contracts/src/facades/interaction.ts'],
  ]),
  workspaceDependencies: new Set(['@agent-device/kernel']),
  externalDependencies: new Map(),
};

const ALL = [kernel, contracts];
const CONTRACT_EXPORTS = [
  '@agent-device/contracts/capture',
  '@agent-device/contracts/client',
  '@agent-device/contracts/command',
  '@agent-device/contracts/device',
  '@agent-device/contracts/divergence',
  '@agent-device/contracts/interaction',
  '@agent-device/contracts/observability',
  '@agent-device/contracts/platform',
  '@agent-device/contracts/progress',
  '@agent-device/contracts/recording',
  '@agent-device/contracts/remote',
  '@agent-device/contracts/replay',
  '@agent-device/contracts/session',
  '@agent-device/contracts/settings',
] as const;

function rules(violations: { rule: string }[]): string[] {
  return violations.map((violation) => violation.rule);
}

test('specifier sites carry 1-based lines for static and dynamic imports', () => {
  const sites = specifierSites(
    'src/a.ts',
    ["import { x } from './b.ts';", '', "void import('../c.ts');"].join('\n'),
  );
  assert.deepEqual(
    sites.map(({ specifier, line }) => `${line}:${specifier}`),
    ['1:./b.ts', '3:../c.ts'],
  );
});

test('readNamedExports collects re-export and direct-declaration forms, resolving aliases', () => {
  const source = [
    "export { a, b } from './x.ts';",
    "export type { C, D } from './y.ts';",
    "export { e as f } from './z.ts';",
    "export type { g as h } from './z.ts';",
    'export function i() {}',
    'export const j = 1;',
    'export type K = string;',
    'export interface L {}',
    "export {\n  m,\n  n,\n} from './multi.ts';",
  ].join('\n');
  assert.deepEqual(
    readNamedExports(source),
    ['D', 'C', 'K', 'L', 'a', 'b', 'f', 'h', 'i', 'j', 'm', 'n'].sort(),
  );
});

test('readNamedExports never reports the original name behind an `as` alias', () => {
  const source = "export { internalOnly as publicName } from './x.ts';";
  const names = readNamedExports(source);
  assert.deepEqual(names, ['publicName']);
  assert.ok(!names.includes('internalOnly'));
});

test('readNamedExports resolves `export * as ns` to its one real bound name', () => {
  // Unlike bare `export *`, this binds exactly one importable name (`ns`) —
  // enumerable, not a widening blind spot.
  const source = "export * as ns from './x.ts';";
  assert.deepEqual(readNamedExports(source), ['ns']);
});

// #1555 review P1 (second pass, "the gate also ignores export-star
// declarations, so it can miss future widening"): a facade pinned to an
// exact named-export list must not silently accept a form that widens its
// real surface with no enumerable name at all. These two forms throw instead
// of contributing nothing to the list — plant-verified (temporarily reverted
// to a no-op, confirmed both tests failed, restored) rather than merely
// asserted.
test('readNamedExports rejects a bare `export *` re-export', () => {
  const source = "export { runAdReplay } from './step-loop.ts';\nexport * from './leak.ts';\n";
  assert.throws(() => readNamedExports(source), /export \* from/);
});

test('readNamedExports rejects a default export', () => {
  assert.throws(() => readNamedExports('export default function leak() {}'), /export default/);
  assert.throws(() => readNamedExports('export default 42;'), /export default/);
});

test('readNamedExports reports `export { default as x }` as the named symbol x', () => {
  // The one form that sits between the two rejection rules above: the LOCAL
  // name is `default`, but what it binds in this module — and the only thing
  // a consumer can import — is `x`. Enumerable, so it must be reported, not
  // thrown; and `default` must never appear in the list.
  const names = readNamedExports("export { default as x, b } from './y.ts';");
  assert.deepEqual(names, ['b', 'x']);
  assert.ok(!names.includes('default'));
});

test('readNamedExports collects a local `export { … }` list with no `from`', () => {
  // The re-export tests above all carry a `from`; a façade that declares
  // first and exports at the bottom is the same public surface.
  assert.deepEqual(
    readNamedExports('const a = 1;\ntype T = string;\nexport { a };\nexport type { T };'),
    ['T', 'a'],
  );
});

test('readNamedExports collects every declarator of a multi-declarator export', () => {
  // Documented in the helper's contract; the direct-declaration test above
  // only exercises a single declarator, so the second name went unpinned.
  assert.deepEqual(readNamedExports('export const a = 1, b = 2;'), ['a', 'b']);
});

// `readFacadeExports` is the same enumeration widened from one source string
// to the re-export CHAIN behind a file — the form every `contracts` façade
// is built from. These use the real tree's own barrels rather than fixtures:
// a fixture would pin the walker against a file this repo never ships.
test('readFacadeExports resolves a bare `export *` chain the source-only reader refuses', () => {
  const barrel = path.join(repoRoot, 'packages/contracts/src/facades/session.ts');
  // Source-only: unknowable, so it throws (the merged contract, unchanged).
  assert.throws(() => readNamedExports(fs.readFileSync(barrel, 'utf8')), /export \* from/);
  // Given the FILE, the same barrel is fully enumerable.
  assert.deepEqual(readFacadeExports(barrel), [
    'SESSION_SURFACES',
    'SessionAction',
    'SessionSurface',
    'parseSessionSurface',
  ]);
});

test('readFacadeExports refuses a bare `export *` across a package specifier', () => {
  // A relative star names a module this gate can read; a package star means
  // resolving node_modules into another package's exports map — unbounded
  // widening, the exact thing the gate refuses.
  const scratch = path.join(repoRoot, 'packages/contracts/src/facades/.export-star-probe.ts');
  fs.writeFileSync(scratch, "export * from '@agent-device/kernel/errors';\n");
  try {
    assert.throws(() => readFacadeExports(scratch), /only a relative re-export/);
  } finally {
    fs.rmSync(scratch);
  }
});

test('readFacadeExports still rejects a default export reached through the chain', () => {
  // A default is no more enumerable behind a barrel than in front of one.
  const dir = path.join(repoRoot, 'packages/contracts/src/facades');
  const leaf = path.join(dir, '.default-leaf-probe.ts');
  const barrel = path.join(dir, '.default-barrel-probe.ts');
  fs.writeFileSync(leaf, 'export default function leak() {}\n');
  fs.writeFileSync(barrel, "export * from './.default-leaf-probe.ts';\n");
  try {
    assert.throws(() => readFacadeExports(barrel), /export default/);
  } finally {
    fs.rmSync(leaf);
    fs.rmSync(barrel);
  }
});

// Every workspace package façade, pinned to its exact exported-symbol list.
//
// #1555 established this gate for `@agent-device/ad-replay` (asserted
// separately below, beside the design rationale for that package's two-value
// façade). The exports-subpath checks in the R11 tree test prove only WHICH
// files a package exposes; the symbol lists here prove WHAT those files name.
// Without them a façade grows a symbol silently and only a diff review — of
// the package, not of the gate — would ever notice.
//
// The list is the honest current surface, deliberately untrimmed: several of
// these are wider than their owners would design today (`contracts/interaction`
// alone names 140 symbols), and pinning the real number is what makes the next
// widening visible. Narrowing a façade is a change to that package, with its
// own consumers to fix — not a silent edit to this table.
//
// Maintaining it is mechanical: run the gate, and the assertion prints the
// exact added/removed names. Adding a symbol to a façade means adding it here
// in the same commit — that coupling IS the gate.
const FACADE_SYMBOLS: readonly (readonly [string, readonly string[]])[] = [
  [
    '@agent-device/ad-script',
    [
      'LocalIdentity',
      'ParsedReplayScript',
      'REPLAY_VAR_KEY_RE',
      'ReplayScriptMetadata',
      'ReplayVarScope',
      'TARGET_ANNOTATION_MAX_ANCESTRY',
      'TARGET_ANNOTATION_MAX_FIELD_BYTES',
      'TARGET_ANNOTATION_MAX_PAYLOAD_BYTES',
      'TargetBindingClassification',
      'TargetBindingClassificationInput',
      'annotationLocalIdentity',
      'appendScriptSeriesFlags',
      'buildReplayVarScope',
      'classifyTargetBindingMatch',
      'collectReplayScrubbableVarValues',
      'collectReplayShellEnv',
      'firstAncestryMismatch',
      'formatDivergenceActionLabel',
      'formatPortableActionLine',
      'formatScriptArg',
      'formatScriptStringLiteral',
      'formatTargetAnnotationLines',
      'identityFieldMismatches',
      'isClickLikeCommand',
      'isTouchTargetCommand',
      'matchesAncestryPrefix',
      'matchesLocalIdentity',
      'normalizeIdentifierField',
      'normalizeLabelField',
      'normalizeRoleField',
      'parseReplayCliEnvEntries',
      'parseReplayScriptDetailed',
      'parseTargetAnnotationV1Payload',
      'readReplayCliEnvEntries',
      'readReplayScriptMetadata',
      'readReplayShellEnvSource',
      'resolveDeclaredScriptPlatform',
      'resolveReplayAction',
      'serializeTargetAnnotationV1',
      'stripRecordedRefGeneration',
      'truncateToUtf8Bytes',
      'utf8ByteLength',
    ],
  ],
  [
    '@agent-device/contracts/client',
    [
      'AgentDeviceCapabilitiesResult',
      'AgentDeviceClientConfig',
      'AgentDeviceDaemonTransport',
      'AgentDeviceDaemonTransportContext',
      'AgentDeviceDevice',
      'AgentDeviceIdentifiers',
      'AgentDeviceRequestOverrides',
      'AgentDeviceSelectionOptions',
      'AgentDeviceSession',
      'AgentDeviceSessionDevice',
      'AlertCommandOptions',
      'AppCloseOptions',
      'AppCloseResult',
      'AppDeployOptions',
      'AppDeployResult',
      'AppInstallFromSourceOptions',
      'AppInstallFromSourceResult',
      'AppInstallOptions',
      'AppListOptions',
      'AppOpenOptions',
      'AppOpenResult',
      'AppPushOptions',
      'AppStateCommandOptions',
      'AppTriggerEventOptions',
      'AudioOptions',
      'BatchRunOptions',
      'BatchStep',
      'CaptureDiffOptions',
      'CaptureScreenshotOptions',
      'CaptureScreenshotResult',
      'CaptureSnapshotOptions',
      'CaptureSnapshotResult',
      'ClickOptions',
      'ClipboardCommandOptions',
      'CloudArtifactsOptions',
      'CommandExecutionOptions',
      'CommandRequestResult',
      'DeviceBootOptions',
      'DeviceCommandBaseOptions',
      'DeviceShutdownOptions',
      'DoctorCommandOptions',
      'ElementTarget',
      'EventsOptions',
      'FillOptions',
      'FindBaseOptions',
      'FindOptions',
      'FindSnapshotCommandOptions',
      'FlingOptions',
      'FocusOptions',
      'GetOptions',
      'InteractionTarget',
      'InternalRequestOptions',
      'IsOptions',
      'IsStatePredicateOptions',
      'IsTextPredicateOptions',
      'JsonObject',
      'JsonPrimitive',
      'JsonValue',
      'KeyboardCommandOptions',
      'Lease',
      'LeaseAllocateOptions',
      'LeaseOptions',
      'LeaseScopedOptions',
      'LogsOptions',
      'LongPressOptions',
      'MaterializationReleaseOptions',
      'MaterializationReleaseResult',
      'NetworkOptions',
      'PanOptions',
      'PerfOptions',
      'PermissionTarget',
      'PinchOptions',
      'PointTarget',
      'PrepareCommandOptions',
      'PressOptions',
      'ReactNativeCommandOptions',
      'RecordControlOptions',
      'RecordOptions',
      'RefTarget',
      'RepeatedPressOptions',
      'ReplayRunOptions',
      'ReplayTestOptions',
      'RotateGestureOptions',
      'ScrollOptions',
      'SelectorSnapshotCommandOptions',
      'SelectorTarget',
      'SessionCloseResult',
      'SessionSaveScriptOptions',
      'SessionSaveScriptResult',
      'SettingsUpdateOptions',
      'SettleCommandOptions',
      'StartupPerfSample',
      'SwipeGestureOptions',
      'SwipeOptions',
      'TraceOptions',
      'TransformGestureOptions',
      'TypeTextOptions',
      'ViewportCommandOptions',
      'WaitCommandOptions',
      'WaitCommandTarget',
      'isRecord',
    ],
  ],
  [
    '@agent-device/contracts/command',
    [
      'CliFlags',
      'CommandFlags',
      'DEFAULT_BATCH_MAX_STEPS',
      'DaemonBatchStep',
      'DaemonExcludedCliFlag',
      'DispatchedCommand',
      'IOS_SAFARI_BUNDLE_ID',
      'MaestroRuntimeFlags',
      'PrepareCommandResult',
      'PrepareIosRunnerArtifactState',
      'PrepareIosRunnerCacheKind',
      'PrepareIosRunnerTiming',
      'PushCommandResult',
      'assertBatchStepCount',
      'isDeepLinkTarget',
      'isValidBatchMaxSteps',
      'isWebUrl',
      'parseBatchStepRuntime',
      'readBatchStepInputObject',
      'readBatchStepRecord',
      'readOptionalInteger',
      'resolveIosDeviceDeepLinkBundleId',
    ],
  ],
  [
    '@agent-device/contracts/device',
    [
      'AppStateCommandResult',
      'AppsFilter',
      'BootCommandResult',
      'DEFAULT_APPS_FILTER',
      'DEVICE_ROTATIONS',
      'DEVICE_ROTATION_SURFACE_INDEX',
      'DeviceInventoryGroup',
      'DeviceInventoryGroupCounts',
      'DeviceInventoryProvider',
      'DeviceInventoryRequest',
      'DeviceLease',
      'DeviceRotation',
      'LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS',
      'LeaseLifecycleContext',
      'LeaseLifecycleProvider',
      'ProviderDeviceInstallOptions',
      'ProviderDeviceInstallResult',
      'ProviderDeviceRuntime',
      'ProviderExpiredLeaseRecovery',
      'ProviderPortReverseOptions',
      'ShutdownCommandResult',
      'TargetShutdownResult',
      'TriggerAppEventCommandResult',
      'WEB_DESKTOP_DEVICE',
      'assertResolvedAppsFilter',
      'countDeviceInventoryByGroup',
      'deviceRotationOrientation',
      'deviceRotationSurfaceDegrees',
      'parseDeviceRotation',
      'resolveAppsFilter',
      'shouldUseHostMacFastPath',
    ],
  ],
  [
    '@agent-device/contracts/interaction',
    [
      'ALERT_ACTIONS',
      'ALERT_ACTION_RETRY_MS',
      'ALERT_POLL_INTERVAL_MS',
      'AlertAction',
      'AlertInfo',
      'AlertPlatform',
      'AlertSource',
      'AppSwitcherCommandResult',
      'AppleTvRemoteButton',
      'BACK_MODES',
      'BackCommandResult',
      'BackMode',
      'CLICK_BUTTONS',
      'ClickButton',
      'ClickCommandResponseData',
      'ClipboardCommandResult',
      'DEFAULT_ALERT_TIMEOUT_MS',
      'DisambiguationTiebreak',
      'ElementSelectorKey',
      'ElementSelectorTapOptions',
      'ElementTarget',
      'FillCommandResponseData',
      'FillCommandResult',
      'FindCommandResponseData',
      'FlingGesturePayload',
      'GESTURE_DURATION_MAX_MS',
      'GESTURE_DURATION_MIN_MS',
      'GESTURE_FLING_DURATION_MS',
      'GESTURE_INITIAL_ANGLE_DEGREES',
      'GESTURE_KINDS',
      'GESTURE_SAMPLE_INTERVAL_MS',
      'GestureExecutionProfile',
      'GestureIntent',
      'GesturePayload',
      'GesturePlan',
      'GesturePointerCount',
      'GestureReferenceFrame',
      'GestureSemanticInput',
      'GuaranteeEnforcement',
      'HomeCommandResult',
      'INTERACTION_DISPATCH_PATHS',
      'INTERACTION_GUARANTEES',
      'INTERACTION_PATH_IDS',
      'InPageSwipeGesturePlan',
      'InteractionEvidence',
      'InteractionGuarantee',
      'InteractionPathContract',
      'InteractionPathId',
      'InteractionTarget',
      'Interactor',
      'KeyboardCommandResult',
      'LongPressCommandResponseData',
      'LongPressCommandResult',
      'MAESTRO_NON_HITTABLE_FALLBACK_MESSAGE',
      'MultiTouchGesturePlan',
      'NormalizedPublicGesture',
      'OrientationCommandResult',
      'PanGesturePayload',
      'PinchGesturePayload',
      'PointTarget',
      'PointerTrajectory',
      'PointerTrajectorySample',
      'PressCommandResponseData',
      'PressCommandResult',
      'RecordingTargetOverride',
      'RefTarget',
      'ResolutionDiagnosticEntry',
      'ResolutionDisclosure',
      'ResolvedInteractionTarget',
      'ResolvedTarget',
      'RotateCommandResult',
      'RotateGesturePayload',
      'RunnerCallOptions',
      'RunnerContext',
      'SCROLL_DIRECTIONS',
      'SCROLL_DURATION_MAX_MS',
      'SCROLL_INPUT_DIRECTIONS',
      'SWIPE_PATTERNS',
      'SWIPE_PAUSE_MAX_MS',
      'SWIPE_PRESETS',
      'SWIPE_REPETITION_MAX',
      'SWIPE_SERIES_MAX_SCHEDULED_DURATION_MS',
      'ScreenshotOptions',
      'ScrollCommandOptions',
      'ScrollDirection',
      'ScrollDistanceOptions',
      'ScrollGestureOptions',
      'ScrollGesturePlan',
      'ScrollInputDirection',
      'ScrollTimingOptions',
      'SelectorTarget',
      'SettleDiffLine',
      'SettleObservation',
      'SettleParams',
      'SettleTailEntry',
      'SinglePointerGesturePlan',
      'SnapshotOptions',
      'SnapshotResult',
      'SwipeGesturePayload',
      'SwipePattern',
      'SwipePayload',
      'SwipePreset',
      'SwipePresetGesturePlan',
      'TV_REMOTE_BUTTONS',
      'TV_REMOTE_BUTTON_USAGE',
      'TransformGestureParams',
      'TransformGesturePayload',
      'TvRemoteButton',
      'TvRemoteCommandResult',
      'VegaTvRemoteKey',
      'WaitCommandResult',
      'assertExclusiveScrollDistanceInputs',
      'assertNoRemovedSwipeInput',
      'assertScrollGestureInput',
      'buildGesturePlan',
      'buildInPageSwipeGesturePlan',
      'buildScrollGesturePlan',
      'buildSwipePresetGesturePlan',
      'buttonTag',
      'clampGestureCoordinate',
      'describeReplayGestureArityError',
      'gestureDirectionDelta',
      'gesturePayloadFromPositionals',
      'gesturePayloadToPositionals',
      'getClickButtonValidationError',
      'honoredScrollDurationMs',
      'inferGestureReferenceFrame',
      'normalizePublicGesture',
      'normalizePublicSwipeMotion',
      'normalizeScrollDurationMs',
      'parseScrollDirection',
      'parseTvRemoteButton',
      'readGesturePayload',
      'resolveClickButton',
      'singlePointerPlanEndpoints',
      'swipePayloadFromPositionals',
      'toAndroidTvRemoteKeyevent',
      'toAppleTvRemoteButton',
      'toVegaTvRemoteKey',
      'tvRemoteDurationMode',
    ],
  ],
  [
    '@agent-device/contracts/capture',
    [
      'AndroidSnapshotBackendMetadata',
      'BackendSnapshotOptions',
      'BackendSnapshotResult',
      'DiffSnapshotCommandResult',
      'FindLocator',
      'PublicSnapshotCaptureAnnotations',
      'SCREENSHOT_ACTION_FLAG_KEYS',
      'SCREENSHOT_COMMAND_FLAG_KEYS',
      'SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS',
      'ScreenshotDispatchFlags',
      'ScreenshotPublicOptions',
      'ScreenshotRequestFlags',
      'ScreenshotResultData',
      'ScreenshotRuntimeFlags',
      'ScreenshotRuntimeOptions',
      'SnapshotCaptureAnalysis',
      'SnapshotCaptureAnnotations',
      'SnapshotCaptureFreshness',
      'SnapshotDiagnosticsState',
      'SnapshotDiagnosticsSummary',
      'SnapshotDiffLine',
      'SnapshotDiffSummary',
      'SnapshotTimingSample',
      'SnapshotTimingStats',
      'ViewportCommandResult',
      'appendScreenshotScriptFlags',
      'mergeSnapshotDiagnostics',
      'publicSnapshotCaptureAnnotations',
      'readScreenshotScriptFlag',
      'readSerializedSnapshotCaptureAnnotations',
      'readSnapshotDiagnosticsSummary',
      'recordSnapshotTiming',
      'screenshotFlagsFromOptions',
      'screenshotOptionsFromFlags',
      'snapshotCaptureAnnotationsFrom',
      'summarizeSnapshotDiagnostics',
      'summarizeSnapshotTimingSamples',
    ],
  ],
  [
    '@agent-device/contracts/platform',
    [
      'ANDROID_SYSTEM_CHROME_PACKAGE',
      'AndroidInputOwner',
      'AndroidInputOwnership',
      'AndroidInputOwnershipSource',
      'AndroidSystemChromeProvenance',
      'AudioProbeResult',
      'AudioProbeSource',
      'EmptyAudioProbeResultOptions',
      'NormalizeAudioProbeRecordOptions',
      'PlatformGatedProviderResolverKey',
      'PlatformPlugin',
      'RunnerLogicalLeaseContext',
      'assertAppleMultiTouchSupported',
      'classifyAndroidInputOwner',
      'classifyAndroidInputOwnership',
      'emptyAudioProbeResult',
      'hasAndroidSystemChromeProvenance',
      'isAndroidInputMethodOwnedNode',
      'isAndroidSystemChromeWindowResourceId',
      'isAudioProbeSupportedDevice',
      'isFallbackAndroidInputMethodPackage',
      'isFallbackAndroidInputMethodResource',
      'isHostSystemAudioProbeDevice',
      'normalizeAudioProbeRecord',
      'parseAndroidInputMethodPackage',
      'readAndroidActiveInputMethodPackage',
      'stripAndroidSystemChromeProvenance',
      'stripAndroidSystemChromeProvenanceFromNode',
    ],
  ],
  [
    '@agent-device/contracts/settings',
    [
      'PermissionAction',
      'PermissionTarget',
      'SETTINGS_INVALID_ARGS_MESSAGE',
      'SETTINGS_USAGE_OVERRIDE',
      'SettingOptions',
      'getUnsupportedMacOsSettingMessage',
      'isMacOsSettingSupported',
      'parsePermissionAction',
      'parsePermissionTarget',
    ],
  ],
  [
    '@agent-device/contracts/session',
    ['SESSION_SURFACES', 'SessionAction', 'SessionSurface', 'parseSessionSurface'],
  ],
  [
    '@agent-device/contracts/recording',
    [
      'DEFAULT_RECORDING_EXPORT_QUALITY',
      'RECORDING_EXPORT_QUALITIES',
      'RECORDING_SCOPE_VALUES',
      'RecordingAppIdentity',
      'RecordingBackendTag',
      'RecordingCommandResult',
      'RecordingExportQuality',
      'RecordingScope',
      'RecordingStartCommandResult',
      'RecordingStopCommandResult',
      'TraceCommandResult',
      'isRecordingExportQuality',
      'isWholeScreenRecordingScope',
      'recordingQualityInputToExportQuality',
    ],
  ],
  [
    '@agent-device/contracts/observability',
    [
      'AgentArtifactsResult',
      'CloudArtifact',
      'CloudArtifactAvailability',
      'CloudArtifactKind',
      'CloudArtifactProvider',
      'CloudArtifactsQuery',
      'CloudArtifactsResult',
      'CloudArtifactsStatus',
      'CloudProviderSessionResult',
      'DaemonArtifactInventoryEntry',
      'DaemonArtifactsResult',
      'DebugSymbolsCrashFrame',
      'DebugSymbolsCrashSummary',
      'DebugSymbolsImage',
      'DebugSymbolsOptions',
      'DebugSymbolsResult',
      'DoctorCheck',
      'DoctorCommandResult',
      'DoctorKind',
      'DoctorStatus',
      'LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE',
      'LAUNCH_CONSOLE_IOS_SIMULATOR_ONLY_MESSAGE',
      'LOG_ACTION_VALUES',
      'LogAction',
      'LogBackend',
      'NetworkEntry',
      'PERF_ACTION_ERROR_MESSAGE',
      'PERF_ACTION_VALUES',
      'PERF_AREA_ERROR_MESSAGE',
      'PERF_AREA_VALUES',
      'PERF_KIND_ERROR_MESSAGE',
      'PERF_KIND_VALUES',
      'PERF_MEMORY_KIND_ERROR_MESSAGE',
      'PERF_SUBJECT_ERROR_MESSAGE',
      'PERF_SUBJECT_VALUES',
      'PerfAction',
      'PerfArea',
      'PerfKind',
      'PerfMetricsSamplerTag',
      'PerfSubject',
      'isPerfAction',
      'isPerfArea',
      'isPerfKind',
      'isPerfMemoryKind',
      'isPerfSubject',
    ],
  ],
  [
    '@agent-device/contracts/remote',
    [
      'CloudProviderProfileFields',
      'CompanionTunnelScope',
      'MetroBridgeResult',
      'MetroBridgeScope',
      'MetroPrepareKind',
      'MetroPrepareOptions',
      'MetroPrepareResult',
      'MetroReloadOptions',
      'MetroReloadResult',
      'PROVIDER_DEVICE_ORIENTATIONS',
      'PrepareMetroRuntimeResult',
      'ProviderConnectionResource',
      'ProviderConnectionVerification',
      'ProviderDeviceOrientation',
      'ReloadMetroResult',
      'RemoteConfigMetroOptions',
      'RemoteConnectionProfileFields',
      'ResolvedMetroKind',
    ],
  ],
  [
    '@agent-device/contracts/replay',
    [
      'RefFrameEffect',
      'ReplayCommandResult',
      'ReplaySuiteAttemptFailure',
      'ReplaySuiteResult',
      'ReplaySuiteTestFailed',
      'ReplaySuiteTestPassed',
      'ReplaySuiteTestResult',
      'ReplaySuiteTestSkipReason',
      'ReplaySuiteTestSkipped',
      'TargetAncestryEntry',
      'TargetAnnotationV1',
      'TargetRect',
      'TargetScrollRegion',
      'TargetVerification',
    ],
  ],
  [
    '@agent-device/contracts/divergence',
    [
      'REPLAY_DIVERGENCE_DEFAULT_REF_LIMIT',
      'REPLAY_DIVERGENCE_DIGEST_REF_LIMIT',
      'REPLAY_DIVERGENCE_LEVEL_BYTE_LIMITS',
      'REPLAY_DIVERGENCE_SUGGESTION_LIMIT',
      'ReplayDivergence',
      'ReplayDivergenceCause',
      'ReplayDivergenceKind',
      'ReplayDivergenceOverflow',
      'ReplayDivergenceResume',
      'ReplayDivergenceScreen',
      'ReplayDivergenceScreenRef',
      'ReplayDivergenceStep',
      'ReplayDivergenceStepSource',
      'ReplayDivergenceSuggestion',
      'ReplayDivergenceSuggestionBasis',
      'ReplayDivergenceTargetBinding',
      'ReplayDivergenceTargetBindingKind',
      'ReplayDivergenceTargetCandidate',
      'ReplayDivergenceTargetIdentity',
      'ReplayRepairHint',
      'ReplayVarScrubEntry',
      'applyReplayDivergenceLevelCaps',
      'boundReplayDivergence',
      'createReplayDivergenceSanitizer',
      'formatReplayDivergenceReport',
      'measureReplayDivergenceBytes',
      'sanitizeReplayDivergenceField',
      'scrubReplayVarValues',
      'truncateUtf8Field',
    ],
  ],
  [
    '@agent-device/contracts/progress',
    [
      'CommandProgressEvent',
      'ReplayTestProgressEvent',
      'ReplayTestSuiteProgressEvent',
      'RequestProgressEvent',
      'RequestProgressSink',
    ],
  ],
  [
    '@agent-device/kernel/errors',
    [
      'AppError',
      'AppErrorCode',
      'AppErrorDetails',
      'DaemonError',
      'KNOWN_APP_ERROR_CODES',
      'KnownAppErrorCode',
      'NormalizedError',
      'asAppError',
      'defaultHintForCode',
      'isAgentDeviceError',
      'normalizeAgentDeviceError',
      'normalizeError',
      'retriableForErrorCode',
      'throwDaemonError',
      'toAppErrorCode',
    ],
  ],
  [
    '@agent-device/kernel/device',
    [
      'AppleOS',
      'ApplePlatform',
      'DEVICE_TARGETS',
      'DeviceInfo',
      'DeviceKind',
      'DeviceSelector',
      'DeviceTarget',
      'PLATFORMS',
      'PLATFORM_SELECTORS',
      'PUBLIC_PLATFORMS',
      'Platform',
      'PlatformSelector',
      'PublicPlatform',
      'deviceFieldsFromPublicPlatform',
      'isAppleOs',
      'isApplePlatform',
      'isIosFamily',
      'isMacOs',
      'isMobilePlatform',
      'isPlatform',
      'isPublicPlatform',
      'isSerialAddressablePlatform',
      'isTvOsDevice',
      'matchesDeviceSelector',
      'matchesPlatformSelector',
      'publicPlatformString',
      'resolveApplePlatformName',
      'resolveAppleSimulatorSetPathForSelector',
      'resolveDevice',
      'resolveDeviceAppleOs',
      'sortAppleDevicesForSelection',
    ],
  ],
  [
    '@agent-device/kernel/snapshot',
    [
      'HiddenContentHint',
      'Point',
      'REF_GRAMMAR_HINT',
      'RawSnapshotNode',
      'Rect',
      'ScreenshotOverlayRef',
      'SnapshotBackend',
      'SnapshotNode',
      'SnapshotOptions',
      'SnapshotPresentationFlagInput',
      'SnapshotQualityVerdict',
      'SnapshotState',
      'SnapshotUnchanged',
      'SnapshotVisibility',
      'SnapshotVisibilityReason',
      'SplitRef',
      'attachRefs',
      'buildSnapshotPresentationKey',
      'centerOfRect',
      'findNodeByRef',
      'isSnapshotBackend',
      'normalizeRef',
      'snapshotPresentationOptionsFromFlags',
      'splitRefGenerationSuffix',
      'usesMobileSnapshotPresentation',
    ],
  ],
  [
    '@agent-device/kernel/contracts',
    [
      'AppErrorCode',
      'CommandRpcParams',
      'DaemonArtifact',
      'DaemonArtifactKnownType',
      'DaemonArtifactType',
      'DaemonInstallSource',
      'DaemonLockPolicy',
      'DaemonRequest',
      'DaemonRequestMeta',
      'DaemonResponse',
      'DaemonResponseData',
      'DaemonServerMode',
      'DaemonTransportPreference',
      'JsonRpcId',
      'JsonRpcRequestEnvelope',
      'LeaseBackend',
      'NETWORK_INCLUDE_MODES',
      'NetworkIncludeMode',
      'RESPONSE_LEVELS',
      'Rect',
      'ResponseCost',
      'ResponseLevel',
      'SessionIsolationMode',
      'SessionRuntimeHints',
      'SnapshotNode',
      'centerOfRect',
      'commandRpcParamsSchema',
      'daemonRuntimeSchema',
      'defaultHintForCode',
      'isNonDefaultResponseLevel',
      'jsonRpcRequestSchema',
      'normalizeError',
    ],
  ],
  ['@agent-device/kernel/collections', ['uniqueStrings']],
  ['@agent-device/kernel/rect', ['isPositiveFiniteRect', 'rectArea', 'rectContains']],
  ['@agent-device/kernel/redaction', ['redactDiagnosticData']],
  ['@agent-device/kernel/bounds', ['parseBounds']],
  [
    '@agent-device/maestro',
    [
      'MAESTRO_COMPATIBILITY_ADR_URL',
      'MAESTRO_COMPATIBILITY_ISSUE_URL',
      'MAESTRO_COMPAT_LIMITATIONS',
      'MAESTRO_COMPAT_SUPPORTED_CAPABILITIES',
      'MAESTRO_RUNTIME_ADAPTER_POLICY',
      'MaestroActionEvent',
      'MaestroCompletedActionEvent',
      'MaestroDispatchSelector',
      'MaestroExecutionObserver',
      'MaestroExecutionOptions',
      'MaestroExecutionOutcome',
      'MaestroExportOptions',
      'MaestroExportResult',
      'MaestroExportWarning',
      'MaestroFailedAction',
      'MaestroFlow',
      'MaestroObservation',
      'MaestroObservationCondition',
      'MaestroObservationIdentity',
      'MaestroPlatform',
      'MaestroRuntimeCommand',
      'MaestroRuntimeMetrics',
      'MaestroRuntimeOperationContext',
      'MaestroRuntimeOperationResult',
      'MaestroRuntimeOperations',
      'MaestroRuntimePort',
      'MaestroRuntimePortLifecycle',
      'MaestroRuntimeReadContext',
      'MaestroSelector',
      'MaestroSinglePointerGestureInput',
      'MaestroSnapshotTargetQuery',
      'MaestroTargetMatch',
      'MaestroTargetQuery',
      'MaestroTargetResolution',
      'collectMaestroFailureSuggestions',
      'createMaestroRuntimePort',
      'executeMaestroFlow',
      'exportReplayActionsToMaestro',
      'formatMaestroCompatibilityReference',
      'inspectMaestroFlow',
      'literalFromMaestroRegex',
      'maestroObservationMatches',
      'maestroTestFailure',
      'resolveMaestroScrollableGesture',
      'resolveMaestroTargetFromSnapshot',
    ],
  ],
  [
    '@agent-device/provider-limrun',
    [
      'LIMRUN_PROVIDER',
      'LimrunAndroidDeviceSession',
      'LimrunConnectionVerification',
      'LimrunConnectionVerificationOptions',
      'LimrunIosCommandExecution',
      'LimrunIosDeviceSession',
      'LimrunRuntime',
      'LimrunRuntimeDependencies',
      'LimrunRuntimeOptions',
      'createLimrunRuntime',
      'verifyLimrunConnection',
    ],
  ],
  [
    '@agent-device/provider-webdriver',
    [
      'CLOUD_WEBDRIVER_PROVIDERS',
      'CloudWebDriverConnectionVerification',
      'CloudWebDriverConnectionVerificationOptions',
      'CloudWebDriverKnownProviderName',
      'DefaultCloudWebDriverArtifactEnv',
      'DefaultCloudWebDriverProviderRuntimeEnv',
      'ProviderWebDriver',
      'ProviderWebDriverDependencies',
      'RunHostCommand',
      'browserStackOnlyDeviceFeatureFlags',
      'createProviderWebDriver',
      'isCloudWebDriverProviderName',
      'readAwsDeviceFarmRegionFromArn',
      'rejectBrowserStackOnlyDeviceFeatures',
    ],
  ],
  [
    '@agent-device/replay-test',
    [
      'ReplayTestAttemptCancellation',
      'ReplayTestAttemptError',
      'ReplayTestAttemptFailed',
      'ReplayTestAttemptOutcome',
      'ReplayTestAttemptPassed',
      'ReplayTestAttemptStep',
      'ReplayTestAttemptStepSink',
      'ReplayTestBindAttemptCancellation',
      'ReplayTestCleanupSession',
      'ReplayTestDiscoverSources',
      'ReplayTestEmitDiagnostic',
      'ReplayTestEmitProgress',
      'ReplayTestExecutionDependencies',
      'ReplayTestFinalizeAttempt',
      'ReplayTestIsCanceled',
      'ReplayTestManifest',
      'ReplayTestPlatform',
      'ReplayTestResolveShardTargets',
      'ReplayTestRunReplay',
      'ReplayTestRunReplayParams',
      'ReplayTestRuntimeDependencies',
      'ReplayTestShardContext',
      'ReplayTestShardMode',
      'ReplayTestShardTarget',
      'ReplayTestSource',
      'ReplayTestSuiteOutcome',
      'ReplayTestSuiteRequest',
      'ReplayTestTarget',
      'runReplayTestSuite',
    ],
  ],
  [
    '@agent-device/xml',
    [
      'XmlNode',
      'XmlParseOptions',
      'decodeXmlCharacterReferences',
      'escapeXmlTextAndAttribute',
      'parseXmlDocumentSync',
    ],
  ],
];

test('every workspace package façade exports exactly its pinned symbol list', () => {
  const packages = readWorkspacePackages(repoRoot);
  const pinned = new Map(FACADE_SYMBOLS.map(([specifier, names]) => [specifier, names]));
  // The table and the manifests must agree in BOTH directions: a new package
  // (or a new subpath on an existing one) that nobody pinned is exactly the
  // widening this gate exists to catch, so an unpinned façade fails here
  // rather than being silently skipped.
  const declared = packages
    .filter((pkg) => pkg.name !== '@agent-device/ad-replay')
    .flatMap((pkg) => [...pkg.exportTargets.keys()]);
  assert.deepEqual(
    declared.slice().sort(),
    [...pinned.keys()].sort(),
    'every exports-map subpath needs a pinned symbol list (and vice versa)',
  );
  for (const pkg of packages) {
    for (const [specifier, target] of pkg.exportTargets) {
      const expected = pinned.get(specifier);
      if (!expected) continue;
      assert.deepEqual(
        readFacadeExports(path.join(repoRoot, target)),
        [...expected],
        `${specifier} exports exactly its pinned symbol list`,
      );
    }
  }
});

test('double-quoted and re-export routes into packages are not invisible to R11', () => {
  // The scanner is the layering parser, so quote style and statement form
  // cannot carve out a bypass: a double-quoted import, a re-export, and a
  // double-quoted dynamic import into packages/*/src all reach the rule.
  const doubleQuoted = specifierSites(
    'src/utils/exec.ts',
    'import { AppError } from "../../packages/kernel/src/errors.ts";',
  );
  assert.equal(checkRootSites(doubleQuoted, ALL, new Set([kernel.name]), new Set()).length, 1);

  const reExport = specifierSites(
    'src/utils/exec.ts',
    'export { AppError } from "../../packages/kernel/src/errors.ts";',
  );
  assert.equal(checkRootSites(reExport, ALL, new Set([kernel.name]), new Set()).length, 1);

  const dynamic = specifierSites(
    'src/utils/exec.ts',
    'void import("../../packages/kernel/src/errors.ts");',
  );
  assert.equal(checkRootSites(dynamic, ALL, new Set([kernel.name]), new Set()).length, 1);

  const packageEscape = specifierSites(
    'packages/kernel/src/errors.ts',
    'export * from "../../../src/utils/exec.ts";',
  );
  assert.equal(checkPackageInternalSites(kernel, packageEscape, ALL).length, 1);
});

test('a package file importing root src is a violation', () => {
  const sites = specifierSites(
    'packages/kernel/src/errors.ts',
    "import { helper } from '../../../src/utils/exec.ts';",
  );
  assert.deepEqual(rules(checkPackageInternalSites(kernel, sites, ALL)), [
    'R11 package-boundaries',
  ]);
});

test('intra-package relative imports hold', () => {
  const sites = specifierSites(
    'packages/kernel/src/daemon-error.ts',
    "import { AppError } from './errors.ts';",
  );
  assert.deepEqual(checkPackageInternalSites(kernel, sites, ALL), []);
});

test('an exported package self-reference holds while a deep self-import fails', () => {
  const exported = specifierSites(
    'packages/kernel/src/errors.test.ts',
    "import { AppError } from '@agent-device/kernel/errors';",
  );
  assert.deepEqual(checkPackageInternalSites(kernel, exported, ALL), []);

  const deep = specifierSites(
    'packages/kernel/src/errors.test.ts',
    "import { AppError } from '@agent-device/kernel/src/errors.ts';",
  );
  assert.equal(checkPackageInternalSites(kernel, deep, ALL).length, 1);
});

test('a cross-package import needs a workspace:* declaration and an exported subpath', () => {
  const declared = specifierSites(
    'packages/contracts/src/gesture.ts',
    "import { AppError } from '@agent-device/kernel/errors';",
  );
  assert.deepEqual(checkPackageInternalSites(contracts, declared, ALL), []);

  const undeclared = specifierSites(
    'packages/kernel/src/errors.ts',
    "import { g } from '@agent-device/contracts/interaction';",
  );
  assert.equal(checkPackageInternalSites(kernel, undeclared, ALL).length, 1);

  const deep = specifierSites(
    'packages/contracts/src/gesture.ts',
    "import { internal } from '@agent-device/kernel/internal/secret';",
  );
  assert.equal(checkPackageInternalSites(contracts, deep, ALL).length, 1);
});

test('a root src file tunnelling into packages/*/src relatively is a violation', () => {
  const sites = specifierSites(
    'src/utils/exec.ts',
    "import { AppError } from '../../packages/kernel/src/errors.ts';",
  );
  const violations = checkRootSites(sites, ALL, new Set([kernel.name]), new Set());
  assert.deepEqual(rules(violations), ['R11 package-boundaries']);
  assert.match(violations[0]!.message, /instantiate the module twice/);
});

test('the R8 exception requires zero-dep closure membership AND an exports-named target', () => {
  const closure = new Set(['scripts/some-tool/run.ts']);
  const allowed = specifierSites(
    'scripts/some-tool/run.ts',
    "import { AppError } from '../../packages/kernel/src/errors.ts';",
  );
  assert.deepEqual(checkRootSites(allowed, ALL, new Set([kernel.name]), closure), []);

  // Same import, but the file is NOT in any zero-dep closure: scripts/
  // placement alone proves nothing about dual instantiation.
  assert.equal(checkRootSites(allowed, ALL, new Set([kernel.name]), new Set()).length, 1);

  const nonExported = specifierSites(
    'scripts/some-tool/run.ts',
    "import { hidden } from '../../packages/kernel/src/internal.ts';",
  );
  assert.equal(checkRootSites(nonExported, ALL, new Set([kernel.name]), closure).length, 1);
});

test('root workspace specifiers need a root workspace:* entry and an exported subpath', () => {
  const fine = specifierSites(
    'src/cli.ts',
    "import { AppError } from '@agent-device/kernel/errors';",
  );
  assert.deepEqual(checkRootSites(fine, ALL, new Set([kernel.name])), []);

  const undeclared = checkRootSites(fine, ALL, new Set());
  assert.equal(undeclared.length, 1);
  assert.match(undeclared[0]!.message, /workspace:\*/);

  const deep = specifierSites(
    'src/cli.ts',
    "import { x } from '@agent-device/kernel/src/errors.ts';",
  );
  assert.equal(checkRootSites(deep, ALL, new Set([kernel.name]), new Set()).length, 1);

  const unknown = specifierSites('src/cli.ts', "import { x } from '@agent-device/nope/thing';");
  assert.equal(checkRootSites(unknown, ALL, new Set([kernel.name]), new Set()).length, 1);
});

test('the real tree parses, declares, and passes R11', () => {
  const packages = readWorkspacePackages(repoRoot);
  assert.ok(packages.length >= 1, 'expected at least the kernel package');
  const kernelPackage = packages.find((pkg) => pkg.name === '@agent-device/kernel');
  assert.ok(kernelPackage, 'kernel package must exist');
  assert.ok(kernelPackage.exportTargets.size >= 8, 'kernel exports its vocabulary subpaths');
  const contractsPackage = packages.find((pkg) => pkg.name === '@agent-device/contracts');
  assert.ok(contractsPackage, 'contracts package must exist');
  assert.deepEqual([...contractsPackage.exportTargets.keys()].sort(), [...CONTRACT_EXPORTS].sort());
  assert.deepEqual([...contractsPackage.workspaceDependencies], ['@agent-device/kernel']);
  const maestroPackage = packages.find((pkg) => pkg.name === '@agent-device/maestro');
  assert.ok(maestroPackage, 'maestro package must exist');
  assert.deepEqual([...maestroPackage.exportTargets.keys()], ['@agent-device/maestro']);
  assert.deepEqual([...maestroPackage.workspaceDependencies].sort(), [
    '@agent-device/contracts',
    '@agent-device/kernel',
  ]);
  const adScriptPackage = packages.find((pkg) => pkg.name === '@agent-device/ad-script');
  assert.ok(adScriptPackage, 'ad-script package must exist');
  // Locks the "exports only `.`" boundary: a future `/codec` (or any other)
  // subpath widens this key list and fails the assertion (#1478 P5 dossier).
  assert.deepEqual([...adScriptPackage.exportTargets.keys()], ['@agent-device/ad-script']);
  assert.deepEqual([...adScriptPackage.workspaceDependencies].sort(), [
    '@agent-device/contracts',
    '@agent-device/kernel',
  ]);
  const adReplayPackage = packages.find((pkg) => pkg.name === '@agent-device/ad-replay');
  assert.ok(adReplayPackage, 'ad-replay package must exist');
  // Locks the "exports only `.`" boundary: the stage-A wide façade and the
  // `./testing` subpath (the in-memory selector-port adapter, relocated to
  // `src/__tests__/test-utils/`) are both gone as of P5 stage D — a future
  // `./testing` (or any other) subpath widens this key list and fails the
  // assertion.
  assert.deepEqual([...adReplayPackage.exportTargets.keys()], ['@agent-device/ad-replay']);
  assert.deepEqual([...adReplayPackage.workspaceDependencies].sort(), [
    '@agent-device/ad-script',
    '@agent-device/contracts',
    '@agent-device/kernel',
  ]);
  // #1555 review P1 ("add the reviewer-required exact exported-symbol
  // gate"; second pass, "enforce the accepted two-entrypoint facade"; the
  // structural-quality review, "typed façade replaces the zero-type rule"):
  // the exports-subpath assertion above only proves the package exposes one
  // `.` entry point — it says nothing about what that entry point actually
  // NAMES. This pins the exact symbol list `packages/ad-replay/src/index.ts`
  // exports: the binding design's two VALUE entrypoints, `inspectAdReplay`
  // and `runAdReplay` (never a third value), plus the neutral vocabulary
  // their signatures are built from, named explicitly instead of every root
  // consumer hand-deriving `Parameters<...>`/`ReturnType<...>` off them (the
  // shim `src/daemon/ad-replay-facade-types.ts` used to centralize — since
  // deleted). `formatReplaySuccessMessage` (presentation, not engine policy)
  // stays out on purpose — it sits daemon-side beside its one caller. A
  // stray export — intentional or not, including a form `readNamedExports`
  // cannot enumerate a name for (`export *`, `export default` — see the
  // rejection tests below) — must edit this list too, not just slip through
  // the exports-subpath check.
  assert.deepEqual(
    readNamedExports(
      fs.readFileSync(path.join(repoRoot, 'packages/ad-replay/src/index.ts'), 'utf8'),
    ),
    [
      'AdReplayDispatchGuard',
      'AdReplayDispatchOutcome',
      'AdReplayGuardMismatchEvidence',
      'AdReplayLandmarkMismatchEvidence',
      'AdReplayManifest',
      'AdReplayScrubValue',
      'AdReplayStepFailure',
      'AdReplayStepRuntime',
      'AdReplayTargetBindingEvidence',
      'AdReplayTargetClassification',
      'AdReplayVarSources',
      'AdReplayVerificationEntry',
      'AdReplayVerifiedTargetGuard',
      'ReplayRecordedTargetDisambiguation',
      'ReplayRecordedTargetPolicy',
      'ReplayRecordedTargetResolution',
      'ReplaySelectorCandidateOptions',
      'ReplaySelectorExpressionOutcome',
      'ReplaySelectorGrammar',
      'ReplaySelectorPort',
      'inspectAdReplay',
      'runAdReplay',
    ],
  );
  const providerWebDriverPackage = packages.find(
    (pkg) => pkg.name === '@agent-device/provider-webdriver',
  );
  assert.ok(providerWebDriverPackage, 'provider-webdriver package must exist');
  assert.deepEqual(
    [...providerWebDriverPackage.exportTargets.keys()],
    ['@agent-device/provider-webdriver'],
  );
  assert.deepEqual([...providerWebDriverPackage.workspaceDependencies].sort(), [
    '@agent-device/contracts',
    '@agent-device/kernel',
    '@agent-device/xml',
  ]);
  const providerLimrunPackage = packages.find(
    (pkg) => pkg.name === '@agent-device/provider-limrun',
  );
  assert.ok(providerLimrunPackage, 'provider-limrun package must exist');
  assert.deepEqual(
    [...providerLimrunPackage.exportTargets.keys()],
    ['@agent-device/provider-limrun'],
  );
  assert.deepEqual([...providerLimrunPackage.workspaceDependencies].sort(), [
    '@agent-device/contracts',
    '@agent-device/kernel',
  ]);
  const rootExternalDependencies = rootExternalDependencyRanges(repoRoot);
  for (const pkg of packages) {
    for (const [name, range] of pkg.externalDependencies) {
      assert.equal(
        rootExternalDependencies.get(name),
        range,
        `${pkg.name} external dependency ${name} must match the root dependency range`,
      );
    }
  }
  const xmlPackage = packages.find((pkg) => pkg.name === '@agent-device/xml');
  assert.ok(xmlPackage, 'xml package must exist');
  assert.deepEqual([...xmlPackage.exportTargets.keys()], ['@agent-device/xml']);
  assert.deepEqual([...xmlPackage.workspaceDependencies], []);
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/kernel'),
    'root must declare the kernel workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/contracts'),
    'root must declare the contracts workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/maestro'),
    'root must declare the maestro workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/ad-script'),
    'root must declare the ad-script workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/ad-replay'),
    'root must declare the ad-replay workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/provider-webdriver'),
    'root must declare the provider-webdriver workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/provider-limrun'),
    'root must declare the provider-limrun workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/xml'),
    'root must declare the xml workspace dependency',
  );
  assert.deepEqual(checkPackageBoundaries(repoRoot, new Set()), []);
});

test('Node resolution enforces the exports map at runtime', () => {
  // Real resolver, not the gate's model: a deep import is a resolution error,
  // and the legal subpath realpaths OUTSIDE node_modules (pnpm symlink), which
  // is what lets --experimental-strip-types load package sources in dev.
  const resolved = import.meta.resolve('@agent-device/kernel/errors');
  assert.ok(resolved.endsWith('packages/kernel/src/errors.ts'), resolved);
  for (const deep of [
    '@agent-device/kernel/src/errors.ts',
    '@agent-device/kernel/internal-not-exported',
    '@agent-device/kernel',
    '@agent-device/contracts/gesture-plan',
    '@agent-device/contracts/src/gesture-plan.ts',
    '@agent-device/contracts',
    '@agent-device/provider-webdriver/runtime',
    '@agent-device/provider-webdriver/src/runtime.ts',
    '@agent-device/provider-limrun/runtime',
    '@agent-device/provider-limrun/src/runtime.ts',
    '@agent-device/xml/internal/parser',
    '@agent-device/xml/src/index.ts',
    '@agent-device/ad-script/codec',
    '@agent-device/ad-script/internal/script.ts',
    '@agent-device/ad-script/src/index.ts',
    '@agent-device/ad-replay/testing',
    '@agent-device/ad-replay/internal/target-verification.ts',
    '@agent-device/ad-replay/src/index.ts',
  ]) {
    assert.throws(
      () => import.meta.resolve(deep),
      /ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath|No "exports" main/,
      `${deep} must not resolve`,
    );
  }

  const contractsResolved = import.meta.resolve('@agent-device/contracts/interaction');
  assert.ok(
    contractsResolved.endsWith('packages/contracts/src/facades/interaction.ts'),
    contractsResolved,
  );
  const providerWebDriverResolved = import.meta.resolve('@agent-device/provider-webdriver');
  assert.ok(
    providerWebDriverResolved.endsWith('packages/provider-webdriver/src/index.ts'),
    providerWebDriverResolved,
  );
  const providerLimrunResolved = import.meta.resolve('@agent-device/provider-limrun');
  assert.ok(
    providerLimrunResolved.endsWith('packages/provider-limrun/src/index.ts'),
    providerLimrunResolved,
  );
  const xmlResolved = import.meta.resolve('@agent-device/xml');
  assert.ok(xmlResolved.endsWith('packages/xml/src/index.ts'), xmlResolved);
  const adScriptResolved = import.meta.resolve('@agent-device/ad-script');
  assert.ok(adScriptResolved.endsWith('packages/ad-script/src/index.ts'), adScriptResolved);
  const adReplayResolved = import.meta.resolve('@agent-device/ad-replay');
  assert.ok(adReplayResolved.endsWith('packages/ad-replay/src/index.ts'), adReplayResolved);
});
