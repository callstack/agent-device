import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import { redactDiagnosticData } from '@agent-device/kernel/redaction';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';

type PlatformRuntimeShutdownFailure = Readonly<{
  owner: RuntimeOwnerRef;
  error: NormalizedError;
}>;

type PlatformRuntimeShutdownErrorDetails = Readonly<{
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
    failures: failures.map(({ owner, error }) => ({
      owner,
      error: normalizeShutdownFailure(error),
    })),
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

function normalizeShutdownFailure(error: unknown, ancestors = new Set<unknown>()): NormalizedError {
  const normalized = redactDiagnosticData(normalizeError(error));
  if (ancestors.has(error)) return normalized;
  const aggregate =
    error instanceof AggregateError
      ? error
      : error instanceof AppError && error.cause instanceof AggregateError
        ? error.cause
        : undefined;
  if (!aggregate || ancestors.has(aggregate)) return normalized;
  const next = new Set(ancestors).add(error).add(aggregate);
  return {
    ...normalized,
    details: {
      ...normalized.details,
      shutdownFailures: aggregate.errors.map((failure: unknown) =>
        normalizeShutdownFailure(failure, next),
      ),
    },
  };
}
