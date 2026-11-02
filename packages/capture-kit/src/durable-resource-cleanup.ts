import { type CleanupOutcome, isConfirmedCleanup } from '@agent-device/contracts/durable-resource';

/** Shares in-flight cleanup and retains only confirmed release across cleanup and disposal. */
export function createRetryableCleanup(
  clean: () => Promise<CleanupOutcome>,
  assertConfirmed: (outcome: CleanupOutcome) => void,
) {
  let cleanup: Promise<CleanupOutcome> | undefined;
  const forceCleanup = (): Promise<CleanupOutcome> =>
    (cleanup ??= clean().then(
      (outcome) => {
        if (!isConfirmedCleanup(outcome)) cleanup = undefined;
        return outcome;
      },
      (error) => {
        cleanup = undefined;
        throw error;
      },
    ));
  return {
    forceCleanup,
    [Symbol.asyncDispose]: async () => assertConfirmed(await forceCleanup()),
  };
}
