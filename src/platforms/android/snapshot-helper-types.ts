import type { AndroidAdbExecutor, AndroidAdbProvider } from './adb-executor.ts';

export type AndroidSnapshotHelperTransport = 'instrumentation' | 'persistent-session';
export type AndroidSnapshotCaptureMode = 'interactive-windows' | 'active-window';
export type AndroidSnapshotHelperInstallReason =
  | 'missing'
  | 'outdated'
  | 'mismatched'
  | 'unverifiable'
  | 'forced'
  | 'current'
  | 'skipped';

export const ANDROID_SNAPSHOT_HELPER_NAME = 'android-snapshot-helper';
export const ANDROID_SNAPSHOT_HELPER_PACKAGE = 'com.callstack.agentdevice.snapshothelper';
export const ANDROID_SNAPSHOT_HELPER_PROTOCOL = 'android-snapshot-helper-v1';
export const ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT = 'uiautomator-xml';
// Keep common snapshots biased toward post-microinteraction reliability. The
// value is a max wait; callers that need immediate capture can explicitly pass 0.
export const ANDROID_SNAPSHOT_HELPER_WAIT_FOR_IDLE_TIMEOUT_MS = 500;
export const ANDROID_SNAPSHOT_HELPER_WAIT_FOR_IDLE_QUIET_MS = 100;
export const ANDROID_SNAPSHOT_HELPER_COMMAND_OVERHEAD_MS = 5_000;
export const ANDROID_SNAPSHOT_HELPER_CAPTURE_TIMEOUT_MS = 5_000;
export const ANDROID_SNAPSHOT_HELPER_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Who releases the helper's persistent instrumentation session.
 *
 * Android permits ONE UiAutomation owner, so a `command`-scoped call stops the session when it
 * finishes and the next helper call pays a fresh `am instrument` start plus the UiAutomation
 * connect wait. `daemon-session` hands that release to session teardown
 * (`stopSessionAndroidSnapshotHelper`), which every Android session runs, so consecutive commands
 * in one session share one warm helper. Device-scoped work stays `command` so nothing squats
 * UiAutomation once the command returns.
 */
export type AndroidHelperSessionScope = 'command' | 'daemon-session';

/** Threaded by every helper-backed read a session command performs (capture, viewport). */
export type AndroidHelperSessionOptions = { helperSessionScope?: AndroidHelperSessionScope };

export type { AndroidAdbExecutor } from './adb-executor.ts';

export type AndroidSnapshotHelperManifest = {
  name: 'android-snapshot-helper';
  version: string;
  releaseTag?: string;
  assetName?: string;
  apkUrl: string | null;
  sha256: string;
  checksumName?: string;
  packageName: string;
  versionCode: number;
  instrumentationRunner: string;
  minSdk: number;
  targetSdk?: number;
  outputFormat: 'uiautomator-xml';
  statusProtocol: 'android-snapshot-helper-v1';
  installArgs: string[];
};

export type AndroidSnapshotHelperArtifact = {
  apkPath: string;
  manifest: AndroidSnapshotHelperManifest;
};

export type AndroidSnapshotHelperInstallPolicy = 'missing-or-outdated' | 'always' | 'never';

export type AndroidSnapshotHelperInstallResult = {
  packageName: string;
  versionCode: number;
  installedVersionCode?: number;
  installedSha256?: string;
  installed: boolean;
  reason: AndroidSnapshotHelperInstallReason;
};

export type AndroidSnapshotHelperCaptureOptions = {
  adb: AndroidAdbExecutor;
  signal?: AbortSignal;
  adbProvider?: AndroidAdbProvider;
  deviceKey?: string;
  helperVersion?: string;
  helperVersionCode?: number;
  helperSha256?: string;
  packageName?: string;
  instrumentationRunner?: string;
  waitForIdleTimeoutMs?: number;
  waitForIdleQuietMs?: number;
  timeoutMs?: number;
  commandTimeoutMs?: number;
  maxDepth?: number;
  maxNodes?: number;
  outputPath?: string;
  emitChunks?: boolean;
};

export type AndroidSnapshotHelperMetadata = {
  helperApiVersion?: string;
  outputFormat: 'uiautomator-xml';
  waitForIdleTimeoutMs?: number;
  waitForIdleQuietMs?: number;
  timeoutMs?: number;
  maxDepth?: number;
  maxNodes?: number;
  rootPresent?: boolean;
  captureMode?: AndroidSnapshotCaptureMode;
  windowCount?: number;
  nodeCount?: number;
  truncated?: boolean;
  elapsedMs?: number;
  transport?: AndroidSnapshotHelperTransport;
  sessionReused?: boolean;
};

export type AndroidSnapshotHelperOutput = {
  xml: string;
  metadata: AndroidSnapshotHelperMetadata;
};
