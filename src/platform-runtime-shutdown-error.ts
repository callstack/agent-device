import {
  AppError,
  normalizeError,
  type NormalizedError,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';

type PlatformRuntimeShutdownFailure = Readonly<{
  owner: RuntimeOwnerRef;
  error: NormalizedError;
}>;

// Why the platform runtime gateway could not end every owner it holds.
const PLATFORM_RUNTIME_SHUTDOWN_REASONS = {
  // One or more runtime owners failed to shut down; `details.failures` keeps each owner's error and cleanup stays unconfirmed.
  ownerShutdownFailed: { reason: 'platform-owner-shutdown-failed' },
} as const satisfies ReasonTable<'platform runtime'>;

type PlatformRuntimeShutdownErrorDetails = Readonly<{
  reason: typeof PLATFORM_RUNTIME_SHUTDOWN_REASONS.ownerShutdownFailed.reason;
  failures: readonly PlatformRuntimeShutdownFailure[];
}>;

type OwnerShutdownFailure = Readonly<{ owner: RuntimeOwnerRef; error: unknown }>;

/** Preserves every owner failure without granting authority to retry cleanup or release a claim. */
export function createPlatformRuntimeShutdownError(
  failures: readonly [OwnerShutdownFailure, ...OwnerShutdownFailure[]],
): AppError {
  const details: PlatformRuntimeShutdownErrorDetails = {
    reason: PLATFORM_RUNTIME_SHUTDOWN_REASONS.ownerShutdownFailed.reason,
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
      hint: 'Cleanup is unconfirmed. Inspect the owner failures and verify claim ownership before attempting recovery.',
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
