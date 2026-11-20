import { openScope, type Limit, type Scope } from '@agent-device/host-kit/retry';
import type { AgentDeviceRuntime } from '@agent-device/contracts/runtime-contract';

/**
 * A timeout carries `error` when the deadline cancelled the task in flight. It carries no `error`
 * when the task answered, but after the cutoff.
 */
export type WaitDeadlineResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true; error?: unknown };

type WaitDeadlineRuntime = Pick<AgentDeviceRuntime, 'signal' | 'clock'>;

type AbortSignalSource = { signal?: AbortSignal };

/**
 * Applies a wait's remaining budget by cancellation, then waits for the operation to quiesce.
 * This deliberately does not race-and-abandon the task: a late snapshot could otherwise mutate
 * session state or keep ownership of a platform helper after the wait has returned.
 *
 * The scope owns the cutoff and decides publication on the wait's own clock, so a capture that
 * answers after the cutoff is a timeout even when it answered before the deadline timer's callback
 * ran (#4789). Cancellation this wait inherited outranks its own budget, so a caller's abort stays
 * the caller's reason rather than becoming a wait timeout.
 */
export async function runWithinWaitDeadline<T>(
  runtime: WaitDeadlineRuntime,
  options: AbortSignalSource,
  remainingMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<WaitDeadlineResult<T>> {
  const parentSignals = [options.signal, runtime.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  // The error the scope raised when its budget ran out: what tells a capture the deadline cancelled
  // it apart from a capture that failed on its own after the budget was already spent.
  let expiry: Error | undefined;
  const limit: Limit = {
    maxMs: remainingMs,
    expired: () => (expiry ??= new DOMException('Wait deadline exceeded', 'TimeoutError')),
  };
  // The runtime clock when a caller supplied one, else the scope's monotonic default: a wall-clock
  // jump must not refuse a capture.
  const clock = runtime.clock;
  const scope: Scope = openScope(
    AbortSignal.any(parentSignals),
    limit,
    clock ? () => clock.now() : undefined,
  );
  // Whether the capture itself finished: what separates a value the scope refused from a capture the
  // deadline cancelled while it was still in flight.
  let captured = false;
  try {
    const value = await task(scope.signal);
    captured = true;
    return { timedOut: false, value: scope.commit(() => value) };
  } catch (error) {
    // A capture that failed on its own keeps its own cause: the wait does not report a timeout for a
    // failure it did not cause, and a caller's cancellation is the caller's reason.
    if (expiry === undefined || parentSignals.some((signal) => signal.aborted)) throw error;
    // A value the scope refused carries no cause beyond the cutoff; a capture the deadline
    // cancelled mid-flight carries its own cause along as the timeout's evidence.
    return captured ? { timedOut: true } : { timedOut: true, error };
  } finally {
    scope.close();
  }
}
