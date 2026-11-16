import type {
  ReplayTestAttemptError,
  ReplayTestAttemptFailed,
} from '@agent-device/contracts/replay-test-execution';
import type { SnapshotDiagnosticsSummary } from '@agent-device/contracts/capture';

/** Neutral failure outcome helper; keeps timeout/unknown construction in one place. */
export function replayTestAttemptFailure(params: {
  error: ReplayTestAttemptError;
  artifactPaths?: readonly string[];
  warnings?: readonly string[];
  infrastructure?: boolean;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
}): ReplayTestAttemptFailed {
  return {
    status: 'failed',
    error: params.error,
    artifactPaths: params.artifactPaths ?? [],
    warnings: params.warnings ?? [],
    infrastructure: params.infrastructure ?? false,
    ...(params.snapshotDiagnostics ? { snapshotDiagnostics: params.snapshotDiagnostics } : {}),
  };
}
