import { waitForDetachedAttempt } from '../detached-attempt.ts';
import {
  createNativeBuildDeadline,
  remainingNativeBuildMs,
  type NativeBuildDeadline,
} from '../native-build/deadline.ts';
import { fromNativeBuildError, snapshotSourceError } from './errors.ts';

/** The same deadline shape every native build/cache in this package reads against (#2970). */
export type SnapshotSourceDeadline = NativeBuildDeadline;

export function createSnapshotSourceDeadline(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  now: () => number = Date.now,
): SnapshotSourceDeadline {
  if (signal?.aborted) throw snapshotSourceError('cancelled', 'abort-signal');
  return createNativeBuildDeadline(timeoutMs, signal, now);
}

/** Behaves exactly like the shared `remainingNativeBuildMs`, but keys its failure on `SnapshotSourceError`. */
export function remainingSnapshotSourceMs(deadline: SnapshotSourceDeadline, code: string): number {
  try {
    return remainingNativeBuildMs(deadline, code);
  } catch (error) {
    throw fromNativeBuildError(error);
  }
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
