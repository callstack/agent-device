import { Deadline } from '@agent-device/host-kit/retry';
import { nativeBuildError } from './errors.ts';

export type NativeBuildDeadline = Readonly<{
  clock: Deadline;
  /** The clock the deadline is read against; injected so a test can move time. */
  now: () => number;
  signal: AbortSignal | undefined;
}>;

export function createNativeBuildDeadline(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  now: () => number = Date.now,
): NativeBuildDeadline {
  if (signal?.aborted) throw nativeBuildError('cancelled', 'abort-signal');
  return { clock: Deadline.fromTimeoutMs(timeoutMs, now()), now, signal };
}

export function remainingNativeBuildMs(deadline: NativeBuildDeadline, code: string): number {
  if (deadline.signal?.aborted) throw nativeBuildError('cancelled', 'abort-signal');
  const remainingMs = deadline.clock.remainingMs(deadline.now());
  if (remainingMs <= 0) throw nativeBuildError('timeout', code);
  return Math.max(1, Math.floor(remainingMs));
}
