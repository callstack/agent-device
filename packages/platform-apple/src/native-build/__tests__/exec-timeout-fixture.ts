import { runCmd } from '@agent-device/host-kit/command';
import type { AppError } from '@agent-device/kernel/errors';

/** Long enough that the kill always lands first, short enough to stay out of the test budget. */
const STALL_TIMEOUT_MS = 5;

/**
 * The failure a probe or a compile hits: the real error `exec.ts` raises when it kills a command at
 * the budget it was handed. Hand-building that shape would let the probes keep classifying a kill
 * that exec.ts no longer reports as one.
 */
export async function execKillTimeoutError(): Promise<AppError> {
  // `timeoutMs` bounds the sleep well below its own request, so exec kills it rather than waiting.
  return await runCmd(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    timeoutMs: STALL_TIMEOUT_MS,
  }).then(
    () => {
      throw new Error('the fixture command answered instead of being killed at its timeout');
    },
    (error: unknown) => error as AppError,
  );
}
