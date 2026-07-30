import type { ReplaySuiteTestFailed } from '@agent-device/contracts/replay';
import type { SnapshotDiagnosticsSummary } from '@agent-device/contracts/capture';
import type { ReplayScriptMetadata } from '../../replay/script.ts';
import type { ReplayTestShardContext } from './session-test-sharding.ts';

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
  platform?: ReplayScriptMetadata['platform'];
  target?: ReplayScriptMetadata['target'];
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

export type ReplayTestRuntimeDependencies = {
  runReplay: ReplayTestRunReplay;
  cleanupSession: ReplayTestCleanupSession;
  finalizeAttempt?: ReplayTestFinalizeAttempt;
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
