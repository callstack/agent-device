import type {
  AppLogLiveHandle,
  AppLogLiveHandleImplementation,
} from '@agent-device/contracts/platform';
import { AppError } from '@agent-device/kernel/errors';

/** Test-only constructor for owners that need independently controlled finish and cleanup outcomes. */
export function createTestAppLogLiveHandle(
  implementation: AppLogLiveHandleImplementation,
): AppLogLiveHandle {
  let finish: ReturnType<AppLogLiveHandleImplementation['finish']> | undefined;
  let cleanup: ReturnType<AppLogLiveHandleImplementation['forceCleanup']> | undefined;
  let disposal: Promise<void> | undefined;
  const forceCleanup = () => (cleanup ??= implementation.forceCleanup());
  return Object.freeze({
    inspect: () => implementation.inspect(),
    finish: () => (finish ??= implementation.finish()),
    forceCleanup,
    [Symbol.asyncDispose]: async () => {
      disposal ??= forceCleanup().then((outcome) => {
        if (outcome.status === 'cleaned' || outcome.status === 'already-missing') return;
        throw new AppError(
          'COMMAND_FAILED',
          outcome.message ?? 'Test app-log cleanup could not be confirmed',
          { reason: outcome.reason },
        );
      });
      await disposal;
    },
  });
}
