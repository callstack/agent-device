import { AppError } from '@agent-device/kernel/errors';
import type {
  AppLogCompletion,
  AppLogLiveHandle,
  AppLogLiveHandleImplementation,
} from './app-log-runtime.ts';
import { isConfirmedCleanup, type CleanupOutcome, type FinishOutcome } from './durable-resource.ts';

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
