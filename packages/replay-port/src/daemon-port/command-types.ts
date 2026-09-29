import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { ReplayDivergenceResume, ReplayRepairHint } from '@agent-device/contracts/divergence';
import type {
  ReplayDispatchOptions,
  ReplayObservationAuthorityBinder,
} from '@agent-device/contracts/replay';
import type { SessionAction, SessionScope } from '@agent-device/contracts/session';
import type { SnapshotDiagnosticsState } from '@agent-device/contracts/capture';
import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';
import type { DaemonResponse, SessionRuntimeHints } from '@agent-device/kernel/contracts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SnapshotState } from '@agent-device/kernel/snapshot';

/**
 * The slice of the daemon's live session record replay reads. The daemon passes its full
 * `SessionState`; replay never names the record itself, so the port depends on these fields and
 * nothing else the daemon keeps on a session.
 */
export type ReplaySessionState = Readonly<{
  name: string;
  device: DeviceInfo;
  appBundleId?: string;
  actions: SessionAction[];
  trace?: Readonly<{ outPath: string }>;
  /** Read for presence only: an active recording means replay video must not start another. */
  screenRecording?: object;
  snapshotDiagnostics?: Pick<SnapshotDiagnosticsState, 'samples'>;
}>;

export type ReplaySessionStore = Readonly<{
  get: () => ReplaySessionState | undefined;
  lookup: () => Readonly<{ address: string; session: ReplaySessionState }> | undefined;
  getRuntimeHints: () => SessionRuntimeHints | undefined;
  ensureSessionDir: () => string;
  /** Rejects the request when its device/platform selectors contradict the session's binding. */
  assertSelectorMatches: (flags: DaemonWireRequest['flags']) => void;
  /**
   * The runtime hints an `open` dispatched from this session would run with: the request's own,
   * the session's persisted ones, and the platform defaults the daemon owns.
   */
  resolveOpenRuntimeHints: (params: {
    request: DaemonWireRequest;
    device?: DeviceInfo;
    platform?: 'ios' | 'android';
  }) => SessionRuntimeHints | undefined;
}>;

/**
 * The replay side of the ref-publication owner: the operational capture it reads, a binder for
 * the daemon-side authority that records a capture and publishes exactly its own projection, and
 * the daemon's snapshot capture over this session. The session-store pair the authority is drawn
 * from stays in the daemon.
 */
export type ReplaySessionObservation = Readonly<{
  get: () => ReplaySessionState | undefined;
  bindAuthority: ReplayObservationAuthorityBinder;
  capture: (params: {
    flags: DaemonWireRequest['flags'];
    logPath: string;
  }) => Promise<{ snapshot: SnapshotState }>;
}>;

/** Immutable read projection of the repair-transaction fields the coordinator's writers touch. */
export type ReplaySessionView = Readonly<{
  repairBoundary: number | undefined;
  pendingRecordAndHeal:
    | Readonly<{ expectedFrom: number; actionsCountAtDivergence: number }>
    | undefined;
  /** The session's script-publication state, as arming reads it: kind, target, persisted force. */
  scriptPublication: Readonly<{
    kind: 'none' | 'authoring' | 'repair';
    status: string | undefined;
    targetPath: string | undefined;
    targetForce: boolean;
  }>;
}>;

export type ReplayResumeStamper = Readonly<{
  sessionExists(): boolean;
  stampCorrectiveWatermark(params: {
    resume: ReplayDivergenceResume;
    repairHint: ReplayRepairHint;
    failedIndex: number;
    actions: SessionAction[];
  }): void;
}>;

/**
 * The daemon-owned gateway one replay request reaches the repair transaction and the corrective
 * resume watermark through. The daemon constructs it over its locked session; replay only calls.
 */
export type ReplayCoordinator = {
  view(): ReplaySessionView | undefined;
  armStep(params: {
    saveScript: boolean | string;
    force: boolean | undefined;
    sourcePath: string;
    firstArm: boolean;
  }): void;
  demoteForRerunIfArmed(): void;
  markCompleteIfArmed(): void;
  markSessionHeldIfArmed(response: DaemonResponse): DaemonResponse;
  clearTombstone(): void;
  clearCorrectiveWatermarkIfExpected(expectedFrom: number | undefined): void;
  readonly resumeStamper: ReplayResumeStamper;
};

export type ReplayTestSessionFactory = (sessionName: string, logPath: string) => ReplaySession;

export type ReplaySession = Readonly<{
  /** The effective SessionStore key selected by request binding. */
  name: string;
  logPath: string;
  store: ReplaySessionStore;
  /** Bound observation reads and writes used by the ref-publication owner and divergence capture. */
  observationStore: ReplaySessionObservation;
  /** The repair-transaction gateway the daemon bound over this session. */
  coordinator: ReplayCoordinator;
}>;

export type ReplayDispatchRequest = DaemonWireRequest &
  Readonly<{ dispatch?: ReplayDispatchOptions }>;

export type ReplayInvoke = (request: ReplayDispatchRequest) => Promise<DaemonResponse>;

/** Daemon policy replay consults but does not own. */
export type ReplayDaemonDependencies = Readonly<{
  /** The isolation scope a request opens sessions under. Throws when the request is inadmissible. */
  resolveSessionScope: (request: DaemonWireRequest) => SessionScope;
}>;

export type ReplayCommand = Readonly<{
  request: DaemonWireRequest;
  /**
   * True when the request reached the daemon over its public HTTP surface only: flow scripts are
   * then untrusted, `runScript` HTTP calls may not reach private addresses, and the Maestro engine
   * decides script trust from this input instead of reading `req.internal`. Absent means a local
   * caller, which trusts its own scripts.
   */
  publicNetworkOnly?: true;
  /** The isolation scope the daemon already resolved for this request, when it did. */
  resolvedSessionScope?: SessionScope;
  /** Dispatch options every request this command issues carries, before its own. */
  dispatch?: ReplayDispatchOptions;
  session: ReplaySession;
  invoke: ReplayInvoke;
  dependencies: ReplayDaemonDependencies;
  tracePath?: string;
  onStep?: ReplayTestAttemptStepSink;
}>;

type ReplayRequestContext = Readonly<{
  token: DaemonWireRequest['token'];
  meta: DaemonWireRequest['meta'];
}>;

export type ReplayRecordVideoRequest = Readonly<
  { request: ReplayRequestContext; sessionName: string } & (
    | { phase: 'start'; outputPath: string }
    | { phase: 'stop' }
  )
>;

export type ReplayRecordVideo = (params: ReplayRecordVideoRequest) => Promise<DaemonResponse>;

export type ReplayTestVideoOwner = Readonly<{
  record: ReplayRecordVideo;
  throwIfCanceled: () => void;
}>;

type ReplayTestSessionCleanup = (sessionName: string) => Promise<void>;

export type ReplayTestCommand = ReplayCommand &
  Readonly<{
    createSession: ReplayTestSessionFactory;
    cleanupSession: ReplayTestSessionCleanup;
    video?: ReplayTestVideoOwner;
  }>;
