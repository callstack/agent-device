export type WaitDeadlineResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true; error?: unknown };

type AbortSignalSource = { signal?: AbortSignal };

/**
 * Applies a wait's remaining budget by cancellation, then waits for the operation to quiesce.
 * This deliberately does not race-and-abandon the task: a late snapshot could otherwise mutate
 * session state or keep ownership of a platform helper after the wait has returned.
 */
export async function runWithinWaitDeadline<T>(
  runtime: AbortSignalSource,
  options: AbortSignalSource,
  remainingMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<WaitDeadlineResult<T>> {
  const deadlineController = new AbortController();
  const parentSignals = [options.signal, runtime.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = AbortSignal.any([...parentSignals, deadlineController.signal]);
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
    if (deadlineExpired && !parentSignals.some((parent) => parent.aborted)) {
      return { timedOut: true };
    }
    signal.throwIfAborted();
    return { timedOut: false, value };
  } catch (error) {
    if (deadlineExpired && !parentSignals.some((parent) => parent.aborted)) {
      return { timedOut: true, error };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
