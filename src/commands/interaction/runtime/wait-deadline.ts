import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';

export type WaitDeadlineResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Applies a wait's remaining budget by cancellation, then waits for the operation to quiesce.
 * This deliberately does not race-and-abandon the task: a late snapshot could otherwise mutate
 * session state or keep ownership of a platform helper after the wait has returned.
 */
export async function runWithinWaitDeadline<T>(
  runtime: Pick<AgentDeviceRuntime, 'signal'>,
  options: Pick<CommandContext, 'signal'>,
  remainingMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<WaitDeadlineResult<T>> {
  const deadlineController = new AbortController();
  const parentSignal = options.signal ?? runtime.signal;
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, deadlineController.signal])
    : deadlineController.signal;
  let deadlineExpired = false;
  const timer = setTimeout(
    () => {
      deadlineExpired = true;
      deadlineController.abort(new DOMException('Wait deadline exceeded', 'TimeoutError'));
    },
    Math.max(0, remainingMs),
  );
  timer.unref();

  try {
    const value = await task(signal);
    if (deadlineExpired && !parentSignal?.aborted) return { timedOut: true };
    signal.throwIfAborted();
    return { timedOut: false, value };
  } catch (error) {
    if (deadlineExpired && !parentSignal?.aborted) return { timedOut: true };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
