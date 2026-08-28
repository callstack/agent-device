import { AppError, type AppErrorDetails } from '@agent-device/kernel/errors';
import { WAIT_REASONS, type WaitReason } from '@agent-device/contracts/wait';
import { isUnreadableCaptureContentError } from '@agent-device/contracts/android-snapshot-quality';
import { selectorPollBudget } from '../../../core/selector-pipeline.ts';
import {
  SELECTOR_PIPELINE_POLICIES,
  type SelectorPipelinePolicy,
} from '../../../core/selector-pipeline-policy.ts';
import { runWithinWaitDeadline } from './wait-deadline.ts';

/**
 * The default `wait` budget, read from the row that owns it (#1656) so the
 * number has one home. `wait --stable` shares it: the quiet-window loop is a
 * different observation, run under the same wait deadline.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = SELECTOR_PIPELINE_POLICIES.wait.poll.defaultTimeoutMs;

export type WaitPollDeadline = 'capture-stalled' | 'capture-truncated' | 'runner-restart-exhausted';

export type WaitFailureEvidence = {
  timeoutMs: number;
  readableCaptures: number;
  waitedMs: number;
  runnerRestarted?: true;
  runnerRestartReason?: string;
  runnerRestartCommand?: string;
  runnerRestartCommandId?: string;
  runnerInvalidatedSessionId?: string;
  runnerRestartSessionId?: string;
  logPath?: string;
  diagnosticId?: string;
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

/**
 * The poll stage of the caller's selector-pipeline row (#1656): the deadline
 * and the inter-poll delay come from the row, so a caller cannot invent a
 * budget and a row that resolves against a single capture cannot be polled.
 */
export function createWaitPolling(
  runtime: WaitPollingRuntime,
  options: WaitPollingOptions,
  requestedTimeoutMs: number | null | undefined,
  policy: SelectorPipelinePolicy,
) {
  const budget = selectorPollBudget(policy);
  const timeoutMs = requestedTimeoutMs ?? budget.defaultTimeoutMs;
  const startedAtMs = now(runtime);
  const unreadable = createUnreadablePollTracker();
  let timeoutEvidence: Partial<WaitFailureEvidence> = {};
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
      const runnerRestart = runnerRestartTimeoutEvidence(result.error);
      timeoutEvidence = runnerRestart ?? {};
      // A capture that only becomes readable after its deadline is not evidence for this wait.
      // Count only captures that completed before runWithinWaitDeadline returned a timeout.
      return {
        timedOut: true as const,
        // A poll is a backend stall when no completed capture established a readable observation;
        // the poll index is not evidence. This remains true after one or more unreadable content
        // verdicts followed by a capture that consumes the remaining budget.
        deadline:
          runnerRestart !== undefined
            ? ('runner-restart-exhausted' as const)
            : unreadable.readableCaptures() === 0
              ? ('capture-stalled' as const)
              : ('capture-truncated' as const),
      };
    },
    hasTimeRemaining: () => remainingMs() > 0,
    failureEvidence: (): WaitFailureEvidence => ({
      timeoutMs,
      readableCaptures: unreadable.readableCaptures(),
      waitedMs: now(runtime) - startedAtMs,
      ...timeoutEvidence,
    }),
    rethrowIfNeverReadable: unreadable.rethrowIfNeverReadable,
    sleepUntilNextPoll: async () =>
      await sleepWithWaitCancellation(runtime, options, Math.min(budget.intervalMs, remainingMs())),
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

function waitRunnerRestartExhaustedError(message: string, evidence: WaitFailureEvidence): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: WAIT_REASONS.runnerRestartExhausted satisfies WaitReason,
    waitRunnerRestartExhausted: true,
    ...evidence,
    retriable: true,
    hint: 'An iOS runner restart consumed the wait timeout before a readable snapshot completed. Inspect the diagnostics log for the runner invalidation/restart sequence, then retry.',
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
  if (deadline === 'runner-restart-exhausted') {
    return waitRunnerRestartExhaustedError(message, evidence);
  }
  if (deadline === 'capture-stalled') return waitCaptureStalledError(message, evidence);
  if (deadline === 'capture-truncated') return waitDeadlineExceededError(message, evidence);

  polling.rethrowIfNeverReadable();
  return evidence.readableCaptures === 0
    ? waitCaptureStalledError(message, evidence)
    : waitTargetAbsentError(message, evidence);
}

function runnerRestartTimeoutEvidence(error: unknown): Partial<WaitFailureEvidence> | undefined {
  if (!(error instanceof AppError)) return undefined;
  const details = error.details;
  if (details?.runnerRestarted !== true) return undefined;
  return {
    runnerRestarted: true,
    ...copyStringDetail(details, 'runnerRestartReason'),
    ...copyStringDetail(details, 'runnerRestartCommand'),
    ...copyStringDetail(details, 'runnerRestartCommandId'),
    ...copyStringDetail(details, 'runnerInvalidatedSessionId'),
    ...copyStringDetail(details, 'runnerRestartSessionId'),
    ...copyStringDetail(details, 'logPath'),
    ...copyStringDetail(details, 'diagnosticId'),
  };
}

function copyStringDetail<Key extends keyof WaitFailureEvidence>(
  details: AppErrorDetails | undefined,
  key: Key,
): Partial<Pick<WaitFailureEvidence, Key>> {
  const value = details?.[key];
  return typeof value === 'string' ? ({ [key]: value } as Pick<WaitFailureEvidence, Key>) : {};
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
