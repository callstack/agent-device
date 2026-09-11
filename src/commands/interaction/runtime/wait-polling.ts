import { AppError, type AppErrorDetails } from '@agent-device/kernel/errors';
import { WAIT_REASONS, type WaitReason } from '@agent-device/contracts/wait';
import { isUnreadableCaptureContentError } from '@agent-device/contracts/android-snapshot-quality';
import { selectorPollBudget } from '@agent-device/selectors/selector-pipeline';
import {
  SELECTOR_PIPELINE_POLICIES,
  type SelectorPipelinePolicy,
} from '@agent-device/selectors/selector-pipeline-policy';
import { runWithinWaitDeadline } from './wait-deadline.ts';

/**
 * The default `wait` budget, read from the row that owns it (#1656) so the
 * number has one home. `wait --stable` shares it: the quiet-window loop is a
 * different observation, run under the same wait deadline.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = SELECTOR_PIPELINE_POLICIES.wait.poll.defaultTimeoutMs;

export type WaitPollDeadline = 'capture-stalled' | 'capture-truncated' | 'runner-restart-exhausted';

/**
 * How one poll ended: a readable capture, an unreadable content verdict the wait rode out, a
 * producer refusal the wait rode out because the producer itself classified it as retriable, the
 * deadline cancelling the capture in flight, or that cancellation carrying runner-restart
 * evidence. Whether a readable capture matched is the caller's verdict, not the poll's.
 */
export type WaitPollOutcome =
  | 'readable'
  | 'unreadable'
  | 'retriable'
  | 'deadline'
  | 'runner-restart';

/** One poll on the wait's own clock: when it started after the wait began and how long it ran. */
export type WaitPollRecord = {
  startedMs: number;
  durationMs: number;
  outcome: WaitPollOutcome;
};

/** Keeps a long wait's failure compact: the first polls carry the cold-start cost, the last the end. */
const WAIT_POLL_TIMELINE_HEAD = 5;
const WAIT_POLL_TIMELINE_TAIL = 25;

export type WaitFailureEvidence = {
  timeoutMs: number;
  readableCaptures: number;
  /** Every poll attempted, readable or not. */
  captures: number;
  polls: WaitPollRecord[];
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

export type WaitPollingClassification = {
  isUnreadableError?: (error: unknown) => boolean;
  preserveUnreadableOnStall?: boolean;
};

type UnobservedPollTracker = {
  attempt: <T>(capture: () => Promise<T>) => Promise<T | undefined>;
  /** Why the most recent poll produced no observation, for that poll's timeline entry. */
  lastUnobservedOutcome: () => Extract<WaitPollOutcome, 'unreadable' | 'retriable'> | undefined;
  recordReadableCapture: () => void;
  readableCaptures: () => number;
  rethrowIfNeverReadable: () => void;
};

type WaitFailurePolling = {
  failureEvidence: () => WaitFailureEvidence;
  preserveUnreadableOnStall?: boolean;
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
  classification: WaitPollingClassification = {},
) {
  const budget = selectorPollBudget(policy);
  const timeoutMs = requestedTimeoutMs ?? budget.defaultTimeoutMs;
  const startedAtMs = now(runtime);
  const unobserved = createUnobservedPollTracker(classification.isUnreadableError);
  const polls: WaitPollRecord[] = [];
  let timeoutEvidence: Partial<WaitFailureEvidence> = {};
  const remainingMs = () => Math.max(0, timeoutMs - (now(runtime) - startedAtMs));

  return {
    capture: async <T>(capture: (signal: AbortSignal) => Promise<T>) => {
      let captureWasReadable = false;
      const startedMs = now(runtime) - startedAtMs;
      const recordPoll = (outcome: WaitPollOutcome) =>
        polls.push({ startedMs, durationMs: now(runtime) - startedAtMs - startedMs, outcome });
      const result = await runWithinWaitDeadline(
        runtime,
        options,
        remainingMs(),
        async (signal) =>
          await unobserved.attempt(async () => {
            const value = await capture(signal);
            captureWasReadable = true;
            return value;
          }),
      );
      if (!result.timedOut) {
        if (captureWasReadable) unobserved.recordReadableCapture();
        recordPoll(
          captureWasReadable ? 'readable' : (unobserved.lastUnobservedOutcome() ?? 'unreadable'),
        );
        return result;
      }
      const runnerRestart = runnerRestartTimeoutEvidence(result.error);
      recordPoll(runnerRestart ? 'runner-restart' : 'deadline');
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
            : unobserved.readableCaptures() === 0
              ? ('capture-stalled' as const)
              : ('capture-truncated' as const),
      };
    },
    hasTimeRemaining: () => remainingMs() > 0,
    failureEvidence: (): WaitFailureEvidence => ({
      timeoutMs,
      readableCaptures: unobserved.readableCaptures(),
      captures: polls.length,
      polls: compactPollTimeline(polls),
      waitedMs: now(runtime) - startedAtMs,
      ...timeoutEvidence,
    }),
    preserveUnreadableOnStall: classification.preserveUnreadableOnStall,
    rethrowIfNeverReadable: unobserved.rethrowIfNeverReadable,
    sleepUntilNextPoll: async () =>
      await sleepWithWaitCancellation(runtime, options, Math.min(budget.intervalMs, remainingMs())),
    timeoutMs,
    waitedMs: () => now(runtime) - startedAtMs,
  };
}

function compactPollTimeline(polls: readonly WaitPollRecord[]): WaitPollRecord[] {
  if (polls.length <= WAIT_POLL_TIMELINE_HEAD + WAIT_POLL_TIMELINE_TAIL) return [...polls];
  return [...polls.slice(0, WAIT_POLL_TIMELINE_HEAD), ...polls.slice(-WAIT_POLL_TIMELINE_TAIL)];
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
  if (deadline === 'capture-stalled') {
    if (polling.preserveUnreadableOnStall) polling.rethrowIfNeverReadable();
    return waitCaptureStalledError(message, evidence);
  }
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

/**
 * A failure the producer itself classified as retriable — the iOS runner draining the abandoned
 * main-thread work of a command that exceeded its execution watchdog reports `RUNNER_BUSY` this
 * way (#2484 follow-up). It says the surface was not observable on *this* poll, not that it stays
 * unobservable: `wait` is a budgeted retry loop, so it keeps polling and lets the deadline rather
 * than the first refusal decide. A runner past its wedge threshold reports `RUNNER_WEDGED`, which
 * is not retriable and still ends the wait at once.
 */
function isRetriablePollFailure(error: unknown): boolean {
  return error instanceof AppError && error.details?.retriable === true;
}

/**
 * Rides out the polls that produced no observation and keeps the last one's error, so a wait that
 * never saw a readable capture fails with the reason its polls actually hit rather than a generic
 * timeout. The content classification is the caller's (`wait absent` reads its own observation
 * verdicts); the retriable-refusal arm applies to every wait, because it is about whether the
 * producer could answer at all.
 */
function createUnobservedPollTracker(
  isUnreadableError: (error: unknown) => boolean = isUnreadableCaptureContentError,
): UnobservedPollTracker {
  let readableCaptureCount = 0;
  let lastUnobservedError: unknown;
  let lastUnobservedOutcome: Extract<WaitPollOutcome, 'unreadable' | 'retriable'> | undefined;
  return {
    attempt: async <T>(capture: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await capture();
      } catch (error) {
        if (isUnreadableError(error)) lastUnobservedOutcome = 'unreadable';
        else if (isRetriablePollFailure(error)) lastUnobservedOutcome = 'retriable';
        else throw error;
        lastUnobservedError = error;
        return undefined;
      }
    },
    lastUnobservedOutcome: () => lastUnobservedOutcome,
    recordReadableCapture: () => {
      readableCaptureCount += 1;
    },
    readableCaptures: () => readableCaptureCount,
    rethrowIfNeverReadable: () => {
      if (readableCaptureCount === 0 && lastUnobservedError !== undefined) {
        throw lastUnobservedError;
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
