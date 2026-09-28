import { AppError } from '@agent-device/kernel/errors';

export type NativeBuildFailureKind = 'cancelled' | 'timeout' | 'unsupported';

/**
 * Domain-neutral: carries a build/cache fact (cancellation, timeout, unsupported host) with no
 * knowledge of the snapshot bridge protocol or the fold helper's public error shape. Every consumer
 * maps this to its own error type instead of this module knowing either one (#2970).
 */
export class NativeBuildError extends AppError {
  readonly buildFailureKind: NativeBuildFailureKind;
  readonly buildFailureCode: string;
  /** The details this error was constructed with, before this class's own kind/code stamps. */
  readonly buildDetails: Readonly<Record<string, unknown>>;

  constructor(
    kind: NativeBuildFailureKind,
    code: string,
    message = `native build ${kind}: ${code}`,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(
      'COMMAND_FAILED',
      message,
      {
        ...details,
        nativeBuildFailure: kind,
        nativeBuildFailureCode: code,
        ...(kind === 'cancelled' ? { reason: 'request_canceled' } : {}),
      },
      cause,
    );
    this.name = 'NativeBuildError';
    this.buildFailureKind = kind;
    this.buildFailureCode = code;
    this.buildDetails = details;
  }
}

export function nativeBuildError(
  kind: NativeBuildFailureKind,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): NativeBuildError {
  return new NativeBuildError(kind, code, undefined, details, cause);
}
