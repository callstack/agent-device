import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { ReplayDivergenceResume, ReplayRepairHint } from '@agent-device/contracts/divergence';
import type {
  ReplayBackendCommand,
  ReplayBackendSession,
} from '@agent-device/contracts/replay-backend';
import type { SessionAction, SessionScope } from '@agent-device/contracts/session';
import type { DaemonResponse } from '@agent-device/kernel/contracts';

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

export type ReplaySession = ReplayBackendSession &
  Readonly<{
    /** The repair-transaction gateway the daemon bound over this session. */
    coordinator: ReplayCoordinator;
  }>;

/** Daemon policy replay consults but does not own. */
export type ReplayDaemonDependencies = Readonly<{
  /** The isolation scope a request opens sessions under. Throws when the request is inadmissible. */
  resolveSessionScope: (request: DaemonWireRequest) => SessionScope;
}>;

export type ReplayCommand = Omit<ReplayBackendCommand, 'session'> &
  Readonly<{
    /** The isolation scope the daemon already resolved for this request, when it did. */
    resolvedSessionScope?: SessionScope;
    session: ReplaySession;
    dependencies: ReplayDaemonDependencies;
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
