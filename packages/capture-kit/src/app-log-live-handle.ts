import { AppError } from '@agent-device/kernel/errors';
import {
  isConfirmedCleanup,
  type AppLogCompletion,
  type AppLogLiveHandle,
  type AppLogLiveSnapshot,
  type CleanupOutcome,
  type FinishOutcome,
} from '@agent-device/contracts/platform';

type AppLogLiveHandleImplementation = Readonly<{
  inspect(): AppLogLiveSnapshot;
  finish(): Promise<FinishOutcome<AppLogCompletion>>;
  forceCleanup(): Promise<CleanupOutcome>;
}>;

/** Internal idempotent adapter underlying the narrower public handle factories. */
export function createAppLogLiveHandle(
  implementation: AppLogLiveHandleImplementation,
): AppLogLiveHandle {
  let finish: Promise<FinishOutcome<AppLogCompletion>> | undefined;
  let cleanup: Promise<CleanupOutcome> | undefined;
  let disposal: Promise<void> | undefined;
  const forceCleanup = (): Promise<CleanupOutcome> => (cleanup ??= implementation.forceCleanup());
  return Object.freeze({
    inspect: () => implementation.inspect(),
    finish: () => (finish ??= implementation.finish()),
    forceCleanup,
    [Symbol.asyncDispose]: async () => {
      disposal ??= forceCleanup().then(assertConfirmedCleanup);
      await disposal;
    },
  });
}

/** Derives forced cleanup from an idempotent finish transaction. */
export function createAppLogLiveHandleFromFinish(
  implementation: Readonly<{
    inspect(): AppLogLiveSnapshot;
    finish(): Promise<FinishOutcome<AppLogCompletion>>;
  }>,
): AppLogLiveHandle {
  return createAppLogLiveHandle({
    inspect: implementation.inspect,
    finish: implementation.finish,
    forceCleanup: async () => {
      const outcome = await implementation.finish();
      return outcome.status === 'completed'
        ? { status: 'cleaned' }
        : { status: 'cleanup-pending', reason: outcome.reason, message: outcome.message };
    },
  });
}

function assertConfirmedCleanup(outcome: CleanupOutcome): void {
  if (isConfirmedCleanup(outcome)) return;
  throw new AppError(
    'COMMAND_FAILED',
    outcome.message ?? 'Durable resource cleanup could not be confirmed',
    {
      reason: outcome.reason,
      retriable: outcome.reason !== 'ownership-fence-lost',
      hint:
        outcome.reason === 'ownership-fence-lost'
          ? 'Use the current resource owner or recovery record before retrying cleanup.'
          : 'Keep the recovery record and retry cleanup through the exact runtime owner.',
    },
  );
}
