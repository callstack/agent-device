import type { ReplaySuiteTestFailed } from '@agent-device/contracts/replay';
import type { SnapshotDiagnosticsSummary } from '@agent-device/contracts/capture';
import type {
  ReplayTestProgressEvent,
  ReplayTestSuiteProgressEvent,
} from '@agent-device/contracts/progress';
import type { DeviceTarget, PlatformSelector } from '@agent-device/kernel/device';
import type { ReplayTestShardContext } from './session-test-sharding.ts';

/**
 * The device vocabulary a scheduler may name, sourced from the neutral kernel rather than
 * through `replay/script.ts` (#1478 P3b). These resolve to exactly what the `.ad` metadata
 * types resolved to — `Exclude<PlatformSelector, 'web'>` and `DeviceTarget` — so the manifest
 * shape is unchanged; only the import direction is. A format-neutral scheduler must not name
 * an engine module, and P5 relocates that engine into `packages/ad-replay` regardless.
 */
export type ReplayTestPlatform = Exclude<PlatformSelector, 'web'>;
export type ReplayTestTarget = DeviceTarget;

/**
 * One execution step an engine reports while an attempt runs (#1478 P3, finding 1).
 *
 * Step payloads originate below the attempt boundary, inside engine execution, and used to
 * reach the reporter through a request-global `AsyncLocalStorage` seeded per attempt. The
 * scheduler now hands each attempt a narrow sink instead, so step progress is an explicit
 * per-attempt port with two real adapters (native `.ad` and Maestro) rather than ambient
 * request state the scheduler cannot see.
 */
export type ReplayTestAttemptStep = {
  index: number;
  total: number;
  command?: string;
  value?: string;
};

export type ReplayTestAttemptStepSink = (step: ReplayTestAttemptStep) => void;

/**
 * ADR 0010 error fields exactly as the public suite result publishes them. This is the
 * neutral wire error, not `DaemonResponse`: the scheduler never sees a daemon response shape.
 */
export type ReplayTestAttemptError = ReplaySuiteTestFailed['error'];

export type ReplayTestAttemptPassed = {
  status: 'passed';
  replayed: number;
  healed: number;
  warnings: readonly string[];
  artifactPaths: readonly string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
};

export type ReplayTestAttemptFailed = {
  status: 'failed';
  error: ReplayTestAttemptError;
  artifactPaths: readonly string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  /**
   * The host's verdict that this failure is environmental (device/runner/boot) rather than a
   * test failure, so retrying and continuing the suite cannot help. Classification needs
   * platform boot-diagnostic vocabulary, which the scheduler must not import, so the host
   * tags the outcome and the scheduler only reads the tag.
   */
  infrastructure: boolean;
};

/** Every expected attempt state resolves as a tagged outcome; nothing throws across the seam. */
export type ReplayTestAttemptOutcome = ReplayTestAttemptPassed | ReplayTestAttemptFailed;

export type ReplayTestRunReplayParams = {
  filePath: string;
  sessionName: string;
  platform?: ReplayTestPlatform;
  target?: ReplayTestTarget;
  requestId?: string;
  artifactsDir?: string;
  artifactPaths?: Set<string>;
  tracePath?: string;
  shard?: ReplayTestShardContext;
  onStep?: ReplayTestAttemptStepSink;
};

export type ReplayTestRunReplay = (
  params: ReplayTestRunReplayParams,
) => Promise<ReplayTestAttemptOutcome>;

export type ReplayTestCleanupSession = (sessionName: string) => Promise<void>;

/**
 * Runs after the attempt settles and before cleanup. Returns a failure outcome when
 * finalization itself failed, or `undefined` when there was nothing to finalize.
 */
export type ReplayTestFinalizeAttempt = (params: {
  sessionName: string;
  artifactPaths: Set<string>;
  artifactsDir?: string;
  tracePath?: string;
}) => Promise<ReplayTestAttemptFailed | undefined>;

/**
 * Publishes one reporter-facing progress event (#1478 P3b).
 *
 * The scheduler used to call `emitRequestProgress` directly, which reads a sink out of a
 * request-global `AsyncLocalStorage`. That is ambient authority a format-neutral scheduler
 * cannot hold once it lives in `packages/replay-test`, so the host injects the sink instead.
 *
 * The port is deliberately narrower than `RequestProgressSink`: the scheduler emits suite and
 * per-test events, never `CommandProgressEvent`, so it is not handed the ability to.
 */
export type ReplayTestEmitProgress = (
  event: ReplayTestSuiteProgressEvent | ReplayTestProgressEvent,
) => void;

/**
 * Whether the suite this scheduler is running has been canceled (#1478 P3b).
 *
 * The scheduler used to call `isRequestCanceled(requestId)`, which both reaches a
 * request-global registry and makes it name a daemon request id as the cancellation key.
 * The host binds the predicate to its own request instead, so the scheduler asks a question
 * it is entitled to ask and learns nothing about how cancellation is tracked.
 */
export type ReplayTestIsCanceled = () => boolean;

/**
 * One operational diagnostic (#1478 P3b). `emitDiagnostic` reads a request-global
 * `AsyncLocalStorage` scope, so the scheduler receives the narrow publish capability instead
 * of the module. The level set is spelled out rather than imported so the vocabulary crossing
 * the seam stays neutral.
 */
export type ReplayTestEmitDiagnostic = (event: {
  level?: 'info' | 'warn' | 'error' | 'debug';
  phase: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}) => void;

/**
 * Cancellation binding for one attempt (#1478 P3b).
 *
 * The brief gives the daemon adapter the job of mapping an engine-neutral attempt id to
 * daemon request identifiers and *binding cancellation*. The scheduler still owns timeout
 * policy — it decides when an attempt has run too long — so it needs to say "stop this
 * attempt" and "I am done with it", and nothing more. Registering the abort, relaying a
 * parent request's abort, and clearing the registry entry are all host concerns behind this.
 */
export type ReplayTestAttemptCancellation = {
  /** Signal the running attempt to stop. The scheduler calls this on timeout. */
  cancel: () => void;
  /** Release whatever the host bound for this attempt. Always called once it settles. */
  release: () => void;
};

export type ReplayTestBindAttemptCancellation = (params: {
  attemptId: string;
  parentAttemptId?: string;
}) => ReplayTestAttemptCancellation;

export type ReplayTestRuntimeDependencies = {
  runReplay: ReplayTestRunReplay;
  cleanupSession: ReplayTestCleanupSession;
  finalizeAttempt?: ReplayTestFinalizeAttempt;
  emitProgress: ReplayTestEmitProgress;
  isCanceled: ReplayTestIsCanceled;
  emitDiagnostic: ReplayTestEmitDiagnostic;
  bindAttemptCancellation: ReplayTestBindAttemptCancellation;
};

/** Neutral failure outcome helper; keeps timeout/unknown construction in one place. */
export function replayTestAttemptFailure(params: {
  error: ReplayTestAttemptError;
  artifactPaths?: readonly string[];
  infrastructure?: boolean;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
}): ReplayTestAttemptFailed {
  return {
    status: 'failed',
    error: params.error,
    artifactPaths: params.artifactPaths ?? [],
    infrastructure: params.infrastructure ?? false,
    ...(params.snapshotDiagnostics ? { snapshotDiagnostics: params.snapshotDiagnostics } : {}),
  };
}
