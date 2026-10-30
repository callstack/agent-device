import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import type { RuntimeOwnerRef } from './platform-runtime.ts';

export type PlatformRuntimeShutdownFailure = Readonly<{
  owner: RuntimeOwnerRef;
  error: NormalizedError;
}>;

export type PlatformRuntimeShutdownErrorDetails = Readonly<{
  reason: 'platform-owner-shutdown-failed';
  failures: readonly PlatformRuntimeShutdownFailure[];
}>;

type OwnerShutdownFailure = Readonly<{ owner: RuntimeOwnerRef; error: unknown }>;

/** Preserves every owner failure without granting authority to retry cleanup or release a claim. */
export function createPlatformRuntimeShutdownError(
  failures: readonly [OwnerShutdownFailure, ...OwnerShutdownFailure[]],
): AppError {
  const details: PlatformRuntimeShutdownErrorDetails = {
    reason: 'platform-owner-shutdown-failed',
    failures: failures.map(({ owner, error }) => ({ owner, error: normalizeError(error) })),
  };
  const message = `Platform runtime owner shutdown failed: ${details.failures
    .map(
      ({ owner, error }) =>
        `${owner.kind === 'local-family' ? owner.family : `${owner.provider} (${owner.instance})`}: ${error.message}`,
    )
    .join('; ')}`;
  return new AppError(
    'COMMAND_FAILED',
    message,
    {
      ...details,
      hint: 'Cleanup is unconfirmed; the device claim is still held. Inspect the owner failures before attempting recovery.',
      retriable: false,
    },
    failures.length === 1
      ? failures[0].error
      : new AggregateError(
          failures.map(({ error }) => error),
          'Original platform runtime owner shutdown failures',
        ),
  );
}
