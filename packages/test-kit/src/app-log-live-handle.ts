import { AppError } from '@agent-device/kernel/errors';
import type {
  AppLogCompletion,
  AppLogLiveHandle,
  AppLogLiveSnapshot,
} from '@agent-device/contracts/app-log-runtime';
import {
  isConfirmedCleanup,
  type CleanupOutcome,
  type FinishOutcome,
} from '@agent-device/contracts/durable-resource';

type AppLogLiveHandleImplementation = Readonly<{
  inspect(): AppLogLiveSnapshot;
  finish(): Promise<FinishOutcome<AppLogCompletion>>;
  forceCleanup(): Promise<CleanupOutcome>;
}>;

/**
 * Test-only constructor for owners that need independently controlled finish and cleanup outcomes.
 * It follows the handle contract (idempotent finish and cleanup, disposal confirms cleanup)
 * without importing capture-kit, whose own tests depend on this package.
 */
export function createTestAppLogLiveHandle(
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
      disposal ??= forceCleanup().then((outcome) => {
        if (isConfirmedCleanup(outcome)) return;
        throw new AppError(
          'COMMAND_FAILED',
          outcome.message ?? 'Durable resource cleanup could not be confirmed',
          { reason: outcome.reason },
        );
      });
      await disposal;
    },
  });
}
