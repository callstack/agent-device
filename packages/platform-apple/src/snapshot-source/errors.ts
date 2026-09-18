import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import type { SnapshotSourceFailureKind, SnapshotSourceFailureScope } from './types.ts';

const APP_ERROR_CODE_BY_KIND: Readonly<Record<SnapshotSourceFailureKind, string>> = {
  unsupported: 'UNSUPPORTED_OPERATION',
  'malformed-tree': 'COMMAND_FAILED',
  'stale-target': 'COMMAND_FAILED',
  timeout: 'COMMAND_FAILED',
  cancelled: 'COMMAND_FAILED',
  'process-crash': 'COMMAND_FAILED',
  'transport-failure': 'COMMAND_FAILED',
  preparing: 'COMMAND_FAILED',
};

export class SnapshotSourceError extends AppError {
  readonly failureKind: SnapshotSourceFailureKind;
  readonly failureCode: string;
  readonly failureScope: SnapshotSourceFailureScope;

  constructor(
    kind: SnapshotSourceFailureKind,
    code: string,
    scope: SnapshotSourceFailureScope,
    message = `iOS Simulator snapshot source ${kind}: ${code}`,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(
      APP_ERROR_CODE_BY_KIND[kind],
      message,
      {
        ...details,
        bridgeFailure: kind,
        bridgeFailureCode: code,
        ...(kind === 'cancelled' ? { reason: 'request_canceled' } : {}),
      },
      cause,
    );
    this.name = 'SnapshotSourceError';
    this.failureKind = kind;
    this.failureCode = code;
    this.failureScope = scope;
  }
}

/** A failure that is evidence about the app generation the bridge served. */
export function snapshotSourceError(
  kind: SnapshotSourceFailureKind,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): SnapshotSourceError {
  return new SnapshotSourceError(kind, code, 'generation', undefined, details, cause);
}

/**
 * A failure that is evidence about this capture only. The route keeps the generation on the bridge,
 * so a throw site reaches for this constructor exactly when the next capture must be able to use the
 * bridge again (#2491, #2612).
 */
export function snapshotSourceCaptureError(
  kind: SnapshotSourceFailureKind,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): SnapshotSourceError {
  return new SnapshotSourceError(kind, code, 'capture', undefined, details);
}

export function asSnapshotSourceError(error: unknown): SnapshotSourceError {
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
