import type { AppLogLiveHandle, AppLogLiveSnapshot, AppLogCompletion } from './app-log-runtime.ts';
import { createAppLogLiveHandle } from './app-log-live-handle-core.ts';
import type { FinishOutcome } from './durable-resource.ts';

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
