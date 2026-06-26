import type {
  DaemonArtifact as PublicDaemonArtifact,
  DaemonRequest as PublicDaemonRequest,
  DaemonRequestMeta as PublicDaemonRequestMeta,
  DaemonResponse as PublicDaemonResponse,
  DaemonResponseData as PublicDaemonResponseData,
  DaemonInstallSource as PublicDaemonInstallSource,
  DaemonError,
  LeaseBackend,
  SessionRuntimeHints as PublicSessionRuntimeHints,
} from '../contracts.ts';
export type { DaemonLockPolicy } from '../contracts.ts';
import type { CommandFlags } from '../core/dispatch.ts';
import type { GestureReferenceFrame, ScrollDirection } from '../core/scroll-gesture.ts';
import type { LogBackend } from './network-log.ts';
import type { SessionSurface } from '../core/session-surface.ts';
import type { RecordingExportQuality } from '../core/recording-export-quality.ts';
import type { DeviceInfo, Platform, PlatformSelector } from '../utils/device.ts';
import type { ExecBackgroundResult, ExecResult } from '../utils/exec.ts';
import type { SnapshotState } from '../utils/snapshot.ts';
import type { AppLogState } from './app-log-process.ts';
import type { AndroidNativePerfSession } from '../platforms/android/perf.ts';
import type {
  AppleXctracePerfCapture,
  AppleXctracePerfMode,
} from '../platforms/ios/perf-xctrace.ts';
import type {
  SnapshotDiagnosticsState,
  SnapshotDiagnosticsSummary,
} from '../snapshot-diagnostics.ts';

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
};

export type DaemonRequest = Omit<PublicDaemonRequest, 'token' | 'session' | 'flags' | 'meta'> & {
  token: string;
  session: string;
  flags?: CommandFlags;
  meta?: DaemonRequestMeta;
  internal?: DaemonRequestInternal;
};

export type ReplaySuiteTestSkipReason = 'skipped-by-filter';

export type ReplaySuiteTestPassed = {
  file: string;
  title?: string;
  session: string;
  status: 'passed';
  durationMs: number;
  finalAttemptDurationMs?: number;
  attempts: number;
  artifactsDir?: string;
  replayed: number;
  healed: number;
  warnings?: string[];
  attemptFailures?: ReplaySuiteAttemptFailure[];
  shardIndex?: number;
  shardCount?: number;
  deviceId?: string;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
};

export type ReplaySuiteTestFailed = {
  file: string;
  title?: string;
  session: string;
  status: 'failed';
  durationMs: number;
  attempts: number;
  artifactsDir?: string;
  error: DaemonError;
  shardIndex?: number;
  shardCount?: number;
  deviceId?: string;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
};

export type ReplaySuiteTestSkipped = {
  file: string;
  title?: string;
  status: 'skipped';
  durationMs: 0;
  reason: ReplaySuiteTestSkipReason;
  message: string;
};

export type ReplaySuiteAttemptFailure = {
  attempt: number;
  message: string;
  durationMs?: number;
};

export type ReplaySuiteTestResult =
  | ReplaySuiteTestPassed
  | ReplaySuiteTestFailed
  | ReplaySuiteTestSkipped;

export type ReplaySuiteResult = {
  total: number;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  notRun: number;
  durationMs: number;
  failures: ReplaySuiteTestFailed[];
  tests: ReplaySuiteTestResult[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
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
  device: DeviceInfo;
  createdAt: number;
  surface?: SessionSurface;
  appBundleId?: string;
  appName?: string;
  snapshot?: SnapshotState;
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
  /** Session was created by record start and should be released when recording stops. */
  recordOnlySession?: boolean;
  recordSession?: boolean;
  saveScriptPath?: string;
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
        remotePath: string;
        remotePid: string;
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
};

export type SessionReplayControl =
  | {
      kind: 'maestroRunFlowWhen';
      mode: 'visible' | 'notVisible';
      selector: string;
      actions: SessionAction[];
    }
  | {
      kind: 'retry';
      maxRetries: number;
      actions: SessionAction[];
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
};
