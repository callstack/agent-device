import { Deadline } from '@agent-device/host-kit/retry';
import { waitForDetachedAttempt } from '../detached-attempt.ts';
import { snapshotSourceError } from './errors.ts';

export type SnapshotSourceDeadline = Readonly<{
  clock: Deadline;
  /** The clock the deadline is read against; injected so a test can move time (#2422). */
  now: () => number;
  signal: AbortSignal | undefined;
}>;

export function createSnapshotSourceDeadline(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  now: () => number = Date.now,
): SnapshotSourceDeadline {
  if (signal?.aborted) throw snapshotSourceError('cancelled', 'abort-signal');
  return { clock: Deadline.fromTimeoutMs(timeoutMs, now()), now, signal };
}

export function remainingSnapshotSourceMs(deadline: SnapshotSourceDeadline, code: string): number {
  if (deadline.signal?.aborted) throw snapshotSourceError('cancelled', 'abort-signal');
  const remainingMs = deadline.clock.remainingMs(deadline.now());
  if (remainingMs <= 0) throw snapshotSourceError('timeout', code);
  return Math.max(1, Math.floor(remainingMs));
}

/**
 * Sleeps inside the caller's own deadline, so a client abort stays a typed `cancelled` instead of
 * arriving as a fresh timeout. `stop` is for a caller that no longer needs the sleep because the work
 * it was waiting on answered elsewhere: the delay ends without burning the rest of its budget.
 */
export async function waitForSnapshotSourceDelay(
  deadline: SnapshotSourceDeadline,
  requestedMs: number,
  code: string,
  stop?: AbortSignal,
): Promise<void> {
  const delayMs = Math.min(requestedMs, remainingSnapshotSourceMs(deadline, code));
  await waitForDetachedAttempt({
    waitMs: delayMs,
    signal: deadline.signal,
    stop,
    cancelled: () => snapshotSourceError('cancelled', 'abort-signal'),
  });
}
