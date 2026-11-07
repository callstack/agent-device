import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { NativeBuildError } from '../native-build/errors.ts';
import {
  SnapshotSourceError,
  type SnapshotSourceFailureKind,
} from '@agent-device/capture-kit/snapshot-source-channel';

export { SnapshotSourceError };

export function snapshotSourceError(
  kind: SnapshotSourceFailureKind,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): SnapshotSourceError {
  return new SnapshotSourceError(kind, code, undefined, details, cause);
}

/**
 * Maps the shared native-build/cache module's domain-neutral failure onto this bridge's own error
 * shape, keeping its typed kind, code, details and cause; anything else passes through unchanged
 * for {@link asSnapshotSourceError} to classify.
 */
export function fromNativeBuildError(error: unknown): unknown {
  if (!(error instanceof NativeBuildError)) return error;
  return new SnapshotSourceError(
    error.buildFailureKind,
    error.buildFailureCode,
    undefined,
    error.buildDetails,
    error.cause,
  );
}

export function asSnapshotSourceError(error: unknown): SnapshotSourceError {
  if (error instanceof SnapshotSourceError) return error;
  error = fromNativeBuildError(error);
  if (error instanceof SnapshotSourceError) return error;
  if (isRequestCanceledError(error)) {
    return snapshotSourceError('cancelled', 'abort-signal', {}, error);
  }
  if (error instanceof AppError && typeof error.details?.timeoutMs === 'number') {
    return snapshotSourceError(
      'timeout',
      'host-operation-timeout',
      { timeoutMs: error.details.timeoutMs },
      error,
    );
  }
  return snapshotSourceError(
    'transport-failure',
    'unexpected-host-error',
    { error: error instanceof Error ? error.message : String(error) },
    error,
  );
}
