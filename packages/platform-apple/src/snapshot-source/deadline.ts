import { Deadline } from '@agent-device/host-kit/retry';
import { snapshotSourceError } from './errors.ts';

export type SnapshotSourceDeadline = Readonly<{
  clock: Deadline;
  signal: AbortSignal | undefined;
}>;

export function createSnapshotSourceDeadline(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): SnapshotSourceDeadline {
  if (signal?.aborted) throw snapshotSourceError('cancelled', 'abort-signal');
  return { clock: Deadline.fromTimeoutMs(timeoutMs), signal };
}

export function remainingSnapshotSourceMs(deadline: SnapshotSourceDeadline, code: string): number {
  if (deadline.signal?.aborted) throw snapshotSourceError('cancelled', 'abort-signal');
  const remainingMs = deadline.clock.remainingMs();
  if (remainingMs <= 0) throw snapshotSourceError('timeout', code);
  return Math.max(1, Math.floor(remainingMs));
}

export async function waitForSnapshotSourceDelay(
  deadline: SnapshotSourceDeadline,
  requestedMs: number,
  code: string,
): Promise<void> {
  const delayMs = Math.min(requestedMs, remainingSnapshotSourceMs(deadline, code));
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(resolve), delayMs);
    const onAbort = () => {
      finish(() => reject(snapshotSourceError('cancelled', 'abort-signal')));
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deadline.signal?.removeEventListener('abort', onAbort);
      action();
    };
    deadline.signal?.addEventListener('abort', onAbort, { once: true });
    if (deadline.signal?.aborted) onAbort();
  });
}
