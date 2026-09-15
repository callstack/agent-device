import { Deadline } from '@agent-device/host-kit/retry';
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
 * Sleeps inside the caller's own deadline. `stop` is for a caller that no longer needs the sleep
 * because the work it was waiting on answered elsewhere: the delay resolves instead of burning its
 * remaining budget, while an aborted `deadline` stays a typed `cancelled`.
 *
 * A stop is only ever created by the code that calls this and is always aborted by it afterwards,
 * so it needs no already-aborted check and no listener removal; the deadline's signal is the
 * caller's and does.
 */
export async function waitForSnapshotSourceDelay(
  deadline: SnapshotSourceDeadline,
  requestedMs: number,
  code: string,
  stop?: AbortSignal,
): Promise<void> {
  const delayMs = Math.min(requestedMs, remainingSnapshotSourceMs(deadline, code));
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(resolve), delayMs);
    const onAbort = () => {
      finish(() => reject(snapshotSourceError('cancelled', 'abort-signal')));
    };
    const onStop = () => finish(resolve);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deadline.signal?.removeEventListener('abort', onAbort);
      action();
    };
    deadline.signal?.addEventListener('abort', onAbort, { once: true });
    if (deadline.signal?.aborted) onAbort();
    stop?.addEventListener('abort', onStop, { once: true });
  });
}
