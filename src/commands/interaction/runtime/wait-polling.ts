import { AppError } from '@agent-device/kernel/errors';
import { WAIT_REASONS } from '@agent-device/contracts/interaction';
import { isUnreadableCaptureContentError } from '../../../snapshot/snapshot-quality.ts';
import { runWithinWaitDeadline } from './wait-deadline.ts';

export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const WAIT_POLL_INTERVAL_MS = 300;

export type WaitPollDeadline = 'capture-stalled' | 'capture-truncated';

export type WaitFailureEvidence = {
  timeoutMs: number;
  readableCaptures: number;
  waitedMs: number;
};

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
  recordReadableCapture: () => void;
  readableCaptures: () => number;
  rethrowIfNeverReadable: () => void;
};

type WaitFailurePolling = {
  failureEvidence: () => WaitFailureEvidence;
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
  const remainingMs = () => Math.max(0, timeoutMs - (now(runtime) - startedAtMs));

  return {
    capture: async <T>(capture: (signal: AbortSignal) => Promise<T>) => {
      let captureWasReadable = false;
      const result = await runWithinWaitDeadline(
        runtime,
        options,
        remainingMs(),
        async (signal) =>
          await unreadable.attempt(async () => {
            const value = await capture(signal);
            captureWasReadable = true;
            return value;
          }),
      );
      if (!result.timedOut) {
        if (captureWasReadable) unreadable.recordReadableCapture();
        return result;
      }
      // A capture that only becomes readable after its deadline is not evidence for this wait.
      // Count only captures that completed before runWithinWaitDeadline returned a timeout.
      return {
        timedOut: true as const,
        // A poll is a backend stall when no completed capture established a readable observation;
        // the poll index is not evidence. This remains true after one or more unreadable content
        // verdicts followed by a capture that consumes the remaining budget.
        deadline:
          unreadable.readableCaptures() === 0
            ? ('capture-stalled' as const)
            : ('capture-truncated' as const),
      };
    },
    hasTimeRemaining: () => remainingMs() > 0,
    failureEvidence: (): WaitFailureEvidence => ({
      timeoutMs,
      readableCaptures: unreadable.readableCaptures(),
      waitedMs: now(runtime) - startedAtMs,
    }),
    rethrowIfNeverReadable: unreadable.rethrowIfNeverReadable,
    sleepUntilNextPoll: async () =>
      await sleepWithWaitCancellation(
        runtime,
        options,
        Math.min(WAIT_POLL_INTERVAL_MS, remainingMs()),
      ),
    timeoutMs,
    waitedMs: () => now(runtime) - startedAtMs,
  };
}

function waitCaptureStalledError(message: string, evidence: WaitFailureEvidence): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: WAIT_REASONS.captureStalled,
    captureStalled: true,
    ...evidence,
    retriable: true,
    hint: 'No readable snapshot capture completed before the wait timeout. Retry, or use screenshot to inspect the current surface.',
  });
}

function waitDeadlineExceededError(message: string, evidence: WaitFailureEvidence): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: WAIT_REASONS.deadlineExceeded,
    captureTruncated: true,
    ...evidence,
  });
}

function waitTargetAbsentError(message: string, evidence: WaitFailureEvidence): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: WAIT_REASONS.targetAbsent,
    ...evidence,
  });
}

export function waitTimeoutError(
  message: string,
  polling: WaitFailurePolling,
  deadline: WaitPollDeadline | undefined,
): AppError {
  const evidence = polling.failureEvidence();
  if (deadline === 'capture-stalled') return waitCaptureStalledError(message, evidence);
  if (deadline === 'capture-truncated') return waitDeadlineExceededError(message, evidence);

  polling.rethrowIfNeverReadable();
  return evidence.readableCaptures === 0
    ? waitCaptureStalledError(message, evidence)
    : waitTargetAbsentError(message, evidence);
}

function createUnreadablePollTracker(): UnreadablePollTracker {
  let readableCaptureCount = 0;
  let lastUnreadableError: unknown;
  return {
    attempt: async <T>(capture: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await capture();
      } catch (error) {
        if (!isUnreadableCaptureContentError(error)) throw error;
        lastUnreadableError = error;
        return undefined;
      }
    },
    recordReadableCapture: () => {
      readableCaptureCount += 1;
    },
    readableCaptures: () => readableCaptureCount,
    rethrowIfNeverReadable: () => {
      if (readableCaptureCount === 0 && lastUnreadableError !== undefined) {
        throw lastUnreadableError;
      }
    },
  };
}

function now(runtime: WaitPollingRuntime): number {
  return runtime.clock?.now() ?? Date.now();
}

export async function sleepWithWaitCancellation(
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
