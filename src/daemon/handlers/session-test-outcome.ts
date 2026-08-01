import { readSnapshotDiagnosticsSummary } from '@agent-device/contracts/capture';
import type { DaemonResponse } from '../types.ts';
import { isReplayInfrastructureFailure } from './session-test-infrastructure.ts';
import type { ReplayTestAttemptFailed, ReplayTestAttemptOutcome } from '@agent-device/replay-test';

/**
 * The one place a `DaemonResponse` becomes a neutral replay-test attempt outcome (#1478 P3).
 *
 * The scheduler owns retries, fail-fast, artifacts, and result aggregation, but it must not
 * read a daemon response shape to do so: `ok`, `data`, and `error.details` are the daemon's
 * projection vocabulary, not the scheduler's. Everything the scheduler actually consumes is
 * pulled out here into an explicit tagged value, including the infrastructure verdict, which
 * needs platform boot-diagnostic vocabulary the scheduler may not import.
 */
export function toReplayTestAttemptOutcome(response: DaemonResponse): ReplayTestAttemptOutcome {
  if (!response.ok) {
    return {
      status: 'failed',
      error: response.error,
      artifactPaths: readArtifactPaths(response.error.details?.artifactPaths),
      infrastructure: isReplayInfrastructureFailure(response),
      ...snapshotDiagnostics(response.error.details?.snapshotDiagnostics),
    };
  }
  const data = response.data as Record<string, unknown> | undefined;
  return {
    status: 'passed',
    replayed: typeof data?.replayed === 'number' ? data.replayed : 0,
    healed: typeof data?.healed === 'number' ? data.healed : 0,
    warnings: readStringArray(data?.warnings),
    artifactPaths: readArtifactPaths(data?.artifactPaths),
    ...snapshotDiagnostics(data?.snapshotDiagnostics),
  };
}

/**
 * Attempt finalization reports only failure: a successful finalization has nothing the
 * scheduler can act on, and `undefined` is what its port already means by "nothing to report".
 */
export function toReplayTestFinalizeFailure(
  response: DaemonResponse | undefined,
): ReplayTestAttemptFailed | undefined {
  if (!response || response.ok) return undefined;
  const outcome = toReplayTestAttemptOutcome(response);
  return outcome.status === 'failed' ? outcome : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Artifact paths are copied by name, so the same path twice would collide on the copy. */
function readArtifactPaths(value: unknown): readonly string[] {
  return [...new Set(readStringArray(value))];
}

function snapshotDiagnostics(
  value: unknown,
): Pick<ReplayTestAttemptOutcome, 'snapshotDiagnostics'> {
  const summary = readSnapshotDiagnosticsSummary(value);
  return summary ? { snapshotDiagnostics: summary } : {};
}
