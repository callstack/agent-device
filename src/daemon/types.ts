import type {
  DaemonArtifact as PublicDaemonArtifact,
  DaemonRequest as PublicDaemonRequest,
  DaemonRequestMeta as PublicDaemonRequestMeta,
  DaemonResponse as PublicDaemonResponse,
  DaemonResponseData as PublicDaemonResponseData,
  DaemonInstallSource as PublicDaemonInstallSource,
  LeaseBackend,
  SessionRuntimeHints as PublicSessionRuntimeHints,
} from '../kernel/contracts.ts';
export type { DaemonLockPolicy } from '../kernel/contracts.ts';
import type { CommandFlags } from '../core/dispatch.ts';
import type { GestureReferenceFrame, ScrollDirection } from '../contracts/scroll-gesture.ts';
import type { LogBackend } from './network-log.ts';
import type { SessionSurface } from '../contracts/session-surface.ts';
import type { RecordingExportQuality } from '../core/recording-export-quality.ts';
import type { RecordingScope } from '../contracts/recording-scope.ts';
import type { DeviceInfo, Platform, PlatformSelector } from '../kernel/device.ts';
import type { ExecBackgroundResult, ExecResult } from '../utils/exec.ts';
import type { SnapshotState } from '../kernel/snapshot.ts';
import type { TargetAnnotationV1 } from '../replay/target-identity.ts';
import type { ReplayTargetGuardDenotation } from '../replay/target-identity-node.ts';
import type { AppLogFailure, AppLogState } from './app-log-process.ts';
import type { DeviceLease } from './lease-registry.ts';
import type { AndroidNativePerfSession } from '../platforms/android/perf.ts';
import type {
  AppleXctracePerfCapture,
  AppleXctracePerfMode,
} from '../platforms/apple/core/perf-xctrace.ts';
import type { AudioProbeSource } from '../audio-probe-result.ts';
import type { SnapshotDiagnosticsState } from '../snapshot-diagnostics.ts';
export type {
  ReplaySuiteAttemptFailure,
  ReplaySuiteResult,
  ReplaySuiteTestFailed,
  ReplaySuiteTestPassed,
  ReplaySuiteTestResult,
  ReplaySuiteTestSkipped,
  ReplaySuiteTestSkipReason,
} from '../contracts/replay.ts';

export type DaemonInstallSource = PublicDaemonInstallSource;
export type SessionRuntimeHints = PublicSessionRuntimeHints;
export type DaemonArtifact = PublicDaemonArtifact;
export type DaemonResponseData = PublicDaemonResponseData;

type DaemonRequestMeta = Omit<PublicDaemonRequestMeta, 'installSource' | 'lockPlatform'> & {
  installSource?: DaemonInstallSource;
  lockPlatform?: PlatformSelector;
  leaseBackend?: LeaseBackend;
};

export type DaemonOpenLifecycle = {
  beforeDispatch?: (session: SessionState) => Promise<DaemonResponse | undefined>;
};

type DaemonRequestInternal = {
  openLifecycle?: DaemonOpenLifecycle;
  admittedLease?: DeviceLease;
  /**
   * ADR 0012 step 4 post-resolution guard: the verified target member's
   * normalized local identity AND structural denotation (document order +
   * sibling ordinal), set ONLY by the replay step loop when dispatching an
   * annotated action whose pre-action verification passed. Interaction
   * handlers thread it into command options as `expectedResolvedTarget`;
   * dispatch's own resolution refuses (pre-action) when its winner differs in
   * local identity OR structural position — the latter distinguishes a
   * different same-identity duplicate.
   */
  replayTargetGuard?: ReplayTargetGuardDenotation;
};

export type DaemonRequest = Omit<PublicDaemonRequest, 'token' | 'session' | 'flags' | 'meta'> & {
  token: string;
  session: string;
  flags?: CommandFlags;
  meta?: DaemonRequestMeta;
  internal?: DaemonRequestInternal;
};

export type DaemonResponse = PublicDaemonResponse;
export type DaemonInvokeFn = (req: DaemonRequest) => Promise<DaemonResponse>;

type RecordingTelemetryBase = {
  tMs: number;
  x: number;
  y: number;
  referenceWidth?: number;
  referenceHeight?: number;
};

type RecordingTelemetryTravel = RecordingTelemetryBase & {
  x2: number;
  y2: number;
  durationMs: number;
};

export type RecordingGestureEvent =
  | (RecordingTelemetryBase & {
      kind: 'tap' | 'longpress';
      durationMs?: number;
    })
  | (RecordingTelemetryTravel & {
      kind: 'swipe';
    })
  | (RecordingTelemetryTravel & {
      kind: 'scroll';
      contentDirection: ScrollDirection;
      amount?: number;
      pixels?: number;
    })
  | (RecordingTelemetryTravel & {
      kind: 'back-swipe';
      edge: 'left' | 'right';
    })
  | (RecordingTelemetryBase & {
      kind: 'pinch';
      scale: number;
      durationMs: number;
    });

export type AndroidSnapshotFreshness = {
  action: string;
  markedAt: number;
  baselineCount: number;
  baselineSignatures?: string[];
  routeComparable: boolean;
};

export type PostGestureStabilization = {
  action: string;
  markedAt: number;
};

export type PendingInteractionOutcome = {
  action: string;
  command: string;
  positionals: string[];
  flags?: CommandFlags;
  markedAt: number;
  attemptsRemaining: number;
  preSignature: Array<{
    key: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
};

type SessionRecordingBase = {
  outPath: string;
  clientOutPath?: string;
  telemetryPath?: string;
  warning?: string;
  overlayWarning?: string;
  startedAt: number;
  recordingScope?: RecordingScope;
  recordingBackend?: string;
  recordOnlySession?: boolean;
  activeSessionApp?: {
    bundleId: string;
    name?: string;
  };
  maxSize?: number;
  exportQuality?: RecordingExportQuality;
  showTouches: boolean;
  gestureEvents: RecordingGestureEvent[];
  touchReferenceFrame?: GestureReferenceFrame;
  gestureClockOriginAtMs?: number;
  gestureClockOriginUptimeMs?: number;
  runnerSessionId?: string;
  invalidatedReason?: string;
};

export type RecordingChunk = {
  index: number;
  path: string;
  remotePath: string;
};

type SessionRecordingProcessChild = Pick<ExecBackgroundResult['child'], 'kill' | 'pid'>;

export type SessionState = {
  name: string;
  sessionScope?: {
    kind: 'cwd';
    id: string;
  };
  lease?: {
    leaseId: string;
    tenantId: string;
    runId: string;
    leaseBackend?: LeaseBackend;
    leaseProvider?: string;
    deviceKey?: string;
    clientId?: string;
    expiresAt?: number;
  };
  device: DeviceInfo;
  createdAt: number;
  surface?: SessionSurface;
  appBundleId?: string;
  appName?: string;
  snapshot?: SnapshotState;
  /**
   * Honest-marker for stale client refs (#1076): true when the stored session
   * snapshot was replaced by a capture whose response did NOT hand the new refs
   * to the client (selector-resolution captures, wait/find polling captures,
   * verify-evidence captures, ...). Commands that consume `@ref` arguments while
   * this is true attach a warning — refs are positional indexes into the latest
   * tree, so they may silently resolve to different elements. Cleared only where
   * the client demonstrably receives the new refs (snapshot responses, find
   * responses that return a ref). Set/cleared at the choke points documented in
   * `setSessionSnapshot` (src/daemon/session-snapshot.ts).
   */
  snapshotRefsStale?: boolean;
  /**
   * Monotonically increasing generation of the stored session snapshot (#1076
   * versioned refs). Incremented every time the stored tree is REPLACED — at
   * the `setSessionSnapshot` choke point and in the snapshot/diff command path
   * (`buildNextSnapshotSession`). Ref-issuing responses (snapshot command, find
   * ref outputs) report it once as the additive `refsGeneration` field;
   * consumers may pin refs as `@e12~s3` and get a precise staleness warning
   * when the pinned generation no longer matches the stored tree. Plain number
   * with per-session lifetime — no persistence. The first bump of a lifetime
   * seeds at a random 6-digit base (`nextSnapshotGeneration`), so a pin from a
   * previous lifetime of a reopened same-named session collides only with
   * ~1e-6 probability instead of commonly: cross-lifetime protection is
   * probabilistic (seeded), NOT identity-based.
   */
  snapshotGeneration?: number;
  /** Source snapshot used to resolve repeated `snapshot -s @ref` after scoped output replaces refs. */
  snapshotScopeSource?: SnapshotState;
  /** Last broad snapshot safe for Android route-freshness comparisons after interactive snapshots. */
  lastComparisonSafeSnapshot?: SnapshotState;
  androidSnapshotFreshness?: AndroidSnapshotFreshness;
  postGestureStabilization?: PostGestureStabilization;
  pendingInteractionOutcome?: PendingInteractionOutcome;
  snapshotDiagnostics?: SnapshotDiagnosticsState;
  trace?: {
    outPath: string;
    startedAt: number;
  };
  applePerf?: {
    active?: AppleXctracePerfCapture;
    lastProfileTracePath?: string;
    lastProfileTemplate?: string;
    lastTracePath?: string;
    lastMode?: AppleXctracePerfMode;
  };
  nativePerf?: {
    android?: AndroidNativePerfSession;
  };
  audioProbe?: {
    platform: 'host-system-audio';
    source: AudioProbeSource;
    backend: string;
    sourceCount: number;
    notes: string[];
    child: SessionRecordingProcessChild;
    wait: Promise<ExecResult>;
    statusPath: string;
    startedAt: number;
    durationMs: number;
    bucketMs: number;
  };
  /** Session was created by record start and should be released when recording stops. */
  recordOnlySession?: boolean;
  recordSession?: boolean;
  saveScriptPath?: string;
  /**
   * ADR 0012 decision 6, R6: `session.actions.length` at the `replay
   * --save-script` invocation that armed this session — the repair-run
   * boundary. The healed `.ad` serializes only `session.actions` from this
   * index onward, so a reused session's earlier, unrelated actions never
   * leak into the healed script.
   */
  saveScriptBoundary?: number;
  /**
   * ADR 0012 decision 6: set when `saveScriptPath` was DEFAULTED to the
   * `<original-stem>.healed.ad` sibling (no explicit `--save-script=<out>`).
   * The writer refuses to clobber an existing default healed script, so a
   * second repair against the same original never destroys an unreviewed
   * prior `.healed.ad` diff.
   */
  saveScriptDefaultedHealedPath?: boolean;
  actions: SessionAction[];
  recording?:
    | (SessionRecordingBase & {
        platform: 'ios';
        child: SessionRecordingProcessChild;
        wait: Promise<ExecResult>;
        recorderPid?: number;
        remotePath?: string;
      })
    | (SessionRecordingBase & {
        platform: 'android';
        recordingId?: string;
        remotePath: string;
        remotePid: string;
        remoteStartedAt?: number;
        chunks?: RecordingChunk[];
        rotationTimer?: NodeJS.Timeout;
        rotationPromise?: Promise<void>;
        rotationFailedReason?: string;
        stopping?: boolean;
      })
    | (SessionRecordingBase & {
        platform: 'ios-device-runner';
        remotePath: string;
        runnerStartedAtUptimeMs?: number;
        targetAppReadyUptimeMs?: number;
      })
    | (SessionRecordingBase & {
        platform: 'macos-runner';
        remotePath?: string;
      })
    | (SessionRecordingBase & {
        platform: 'web';
      });
  /** Session-scoped app log stream; logs written to outPath for agent to grep */
  appLog?: {
    platform: Platform;
    backend: LogBackend;
    outPath: string;
    startedAt: number;
    getState: () => AppLogState;
    stop: () => Promise<void>;
    wait: Promise<ExecResult>;
  };
  appLogFailure?: AppLogFailure;
};

/**
 * Per-nested-action source provenance for control-flow wrappers, parallel to
 * `actions`; `undefined` at an index means "the wrapping control action's own
 * file". The runtime block invoker reads it so a failure inside a wrapped
 * `runFlow` include reports the include's file+line, not the wrapper's.
 */
export type ReplayControlActionSource = { path: string; line: number };

export type SessionReplayControl =
  | {
      kind: 'maestroRunFlowWhen';
      mode: 'visible' | 'notVisible';
      selector: string;
      actions: SessionAction[];
      actionSources?: (ReplayControlActionSource | undefined)[];
    }
  | {
      kind: 'retry';
      maxRetries: number;
      actions: SessionAction[];
      actionSources?: (ReplayControlActionSource | undefined)[];
    };

export type SessionAction = {
  ts: number;
  command: string;
  positionals: string[];
  runtime?: SessionRuntimeHints;
  replayControl?: SessionReplayControl;
  flags: Partial<CommandFlags> & {
    snapshotInteractiveOnly?: boolean;
    snapshotDepth?: number;
    snapshotScope?: string;
    snapshotRaw?: boolean;
    launchArgs?: string[];
    saveScript?: boolean | string;
    noRecord?: boolean;
  };
  result?: Record<string, unknown>;
  /**
   * ADR 0012 decision 3: parsed or record-time-computed `target-v1`
   * evidence, written as a comment immediately before this action's line.
   * Inert until migration step 4 adds enforcement.
   */
  targetEvidence?: TargetAnnotationV1;
};
