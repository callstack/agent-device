import { AppError } from '@agent-device/kernel/errors';
import { isUnreadableCaptureContentError } from '../../../snapshot/snapshot-quality.ts';
import { runWithinWaitDeadline } from './wait-deadline.ts';

export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const WAIT_POLL_INTERVAL_MS = 300;

export type WaitPollDeadline = 'capture-stalled' | 'capture-truncated';

type WaitPollingRuntime = {
  clock?: {
    now(): number;
    sleep(ms: number): Promise<void>;
  };
  signal?: AbortSignal;
};

type WaitPollingOptions = {
  signal?: AbortSignal;
};

type UnreadablePollTracker = {
  attempt: <T>(capture: () => Promise<T>) => Promise<T | undefined>;
  rethrowIfNeverReadable: () => void;
};

export function createWaitPolling(
  runtime: WaitPollingRuntime,
  options: WaitPollingOptions,
  requestedTimeoutMs: number | null | undefined,
) {
  const timeoutMs = requestedTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const startedAtMs = now(runtime);
  const unreadable = createUnreadablePollTracker();
  let capturesStarted = 0;
  const remainingMs = () => Math.max(0, timeoutMs - (now(runtime) - startedAtMs));

  return {
    capture: async <T>(capture: (signal: AbortSignal) => Promise<T>) => {
      const receivedWholeWaitBudget = capturesStarted === 0;
      capturesStarted += 1;
      const result = await runWithinWaitDeadline(
        runtime,
        options,
        remainingMs(),
        async (signal) => await unreadable.attempt(() => capture(signal)),
      );
      if (!result.timedOut) return result;
      return {
        timedOut: true as const,
        // Only the first capture receives the wait's entire budget. A later poll is canceled by
        // the enclosing deadline, so classifying it as a backend stall would overstate the evidence.
        deadline: receivedWholeWaitBudget
          ? ('capture-stalled' as const)
          : ('capture-truncated' as const),
      };
    },
    hasTimeRemaining: () => remainingMs() > 0,
    rethrowIfNeverReadable: unreadable.rethrowIfNeverReadable,
    sleepUntilNextPoll: async () =>
      await sleepWithinWait(runtime, options, Math.min(WAIT_POLL_INTERVAL_MS, remainingMs())),
    timeoutMs,
    waitedMs: () => now(runtime) - startedAtMs,
  };
}

export function waitCaptureStalledError(message: string, timeoutMs: number): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: 'wait_capture_stalled',
    captureStalled: true,
    timeoutMs,
    hint: 'A snapshot capture stalled past the wait timeout. Retry, or use screenshot to inspect the current surface.',
  });
}

export function waitDeadlineExceededError(
  message: string,
  timeoutMs: number,
  captureTruncated: boolean,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    message,
    captureTruncated
      ? {
          reason: 'wait_deadline_exceeded',
          captureTruncated: true,
          timeoutMs,
        }
      : undefined,
  );
}

function createUnreadablePollTracker(): UnreadablePollTracker {
  let sawReadableCapture = false;
  let lastUnreadableError: unknown;
  return {
    attempt: async <T>(capture: () => Promise<T>): Promise<T | undefined> => {
      try {
        const result = await capture();
        sawReadableCapture = true;
        return result;
      } catch (error) {
        if (!isUnreadableCaptureContentError(error)) throw error;
        lastUnreadableError = error;
        return undefined;
      }
    },
    rethrowIfNeverReadable: () => {
      if (!sawReadableCapture && lastUnreadableError !== undefined) throw lastUnreadableError;
    },
  };
}

function now(runtime: WaitPollingRuntime): number {
  return runtime.clock?.now() ?? Date.now();
}

async function sleepWithinWait(
  runtime: WaitPollingRuntime,
  options: WaitPollingOptions,
  durationMs: number,
): Promise<boolean> {
  const parentSignals = [options.signal, runtime.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  for (const signal of parentSignals) signal.throwIfAborted();
  if (durationMs <= 0) return false;

  if (runtime.clock) {
    await runtime.clock.sleep(durationMs);
    for (const signal of parentSignals) signal.throwIfAborted();
    return true;
  }

  await new Promise<void>((resolve, reject) => {
    const signal = parentSignals.length > 0 ? AbortSignal.any(parentSignals) : undefined;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer.unref();
  });
  return true;
}
