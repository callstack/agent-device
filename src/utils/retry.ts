import { AppError } from '../kernel/errors.ts';
import { emitDiagnostic } from './diagnostics.ts';

type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
};

type RetryAttemptContext = {
  attempt: number;
  maxAttempts: number;
  deadline?: Deadline;
};

type RetryTelemetryEvent = {
  phase?: string;
  event: 'attempt_failed' | 'retry_scheduled' | 'succeeded' | 'exhausted';
  attempt: number;
  maxAttempts: number;
  delayMs?: number;
  elapsedMs?: number;
  remainingMs?: number;
  reason?: string;
};

export function isEnvTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

const defaultOptions: Pick<RetryPolicy, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'jitter'> = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2000,
  jitter: 0.2,
};

export class Deadline {
  private readonly startedAtMs: number;
  private readonly expiresAtMs: number;

  private constructor(startedAtMs: number, timeoutMs: number) {
    this.startedAtMs = startedAtMs;
    this.expiresAtMs = startedAtMs + Math.max(0, timeoutMs);
  }

  static fromTimeoutMs(timeoutMs: number, nowMs = Date.now()): Deadline {
    return new Deadline(nowMs, timeoutMs);
  }

  remainingMs(nowMs = Date.now()): number {
    return Math.max(0, this.expiresAtMs - nowMs);
  }

  elapsedMs(nowMs = Date.now()): number {
    return Math.max(0, nowMs - this.startedAtMs);
  }

  isExpired(nowMs = Date.now()): boolean {
    return this.remainingMs(nowMs) <= 0;
  }
}

export async function retryWithPolicy<T>(
  fn: (context: RetryAttemptContext) => Promise<T>,
  policy: Partial<RetryPolicy> = {},
  options: {
    deadline?: Deadline;
    phase?: string;
    signal?: AbortSignal;
    classifyReason?: (error: unknown) => string | undefined;
    onEvent?: (event: RetryTelemetryEvent) => void;
  } = {},
): Promise<T> {
  const merged: RetryPolicy = {
    maxAttempts: policy.maxAttempts ?? defaultOptions.maxAttempts,
    baseDelayMs: policy.baseDelayMs ?? defaultOptions.baseDelayMs,
    maxDelayMs: policy.maxDelayMs ?? defaultOptions.maxDelayMs,
    jitter: policy.jitter ?? defaultOptions.jitter,
    shouldRetry: policy.shouldRetry,
  };
  let lastError: unknown;
  for (let attempt = 1; attempt <= merged.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new AppError('COMMAND_FAILED', 'request canceled', { reason: 'request_canceled' });
    }
    if (options.deadline?.isExpired() && attempt > 1) break;
    try {
      const result = await fn({
        attempt,
        maxAttempts: merged.maxAttempts,
        deadline: options.deadline,
      });
      options.onEvent?.({
        phase: options.phase,
        event: 'succeeded',
        attempt,
        maxAttempts: merged.maxAttempts,
        elapsedMs: options.deadline?.elapsedMs(),
        remainingMs: options.deadline?.remainingMs(),
      });
      publishRetryEvent({
        phase: options.phase,
        event: 'succeeded',
        attempt,
        maxAttempts: merged.maxAttempts,
        elapsedMs: options.deadline?.elapsedMs(),
        remainingMs: options.deadline?.remainingMs(),
      });
      return result;
    } catch (err) {
      lastError = err;
      const reason = options.classifyReason?.(err);
      const failedEvent: RetryTelemetryEvent = {
        phase: options.phase,
        event: 'attempt_failed',
        attempt,
        maxAttempts: merged.maxAttempts,
        elapsedMs: options.deadline?.elapsedMs(),
        remainingMs: options.deadline?.remainingMs(),
        reason,
      };
      options.onEvent?.(failedEvent);
      publishRetryEvent(failedEvent);
      if (attempt >= merged.maxAttempts) break;
      if (merged.shouldRetry && !merged.shouldRetry(err, attempt)) break;
      const delay = computeDelay(merged.baseDelayMs, merged.maxDelayMs, merged.jitter, attempt);
      const boundedDelay = options.deadline
        ? Math.min(delay, options.deadline.remainingMs())
        : delay;
      if (boundedDelay <= 0) break;
      const retryEvent: RetryTelemetryEvent = {
        phase: options.phase,
        event: 'retry_scheduled',
        attempt,
        maxAttempts: merged.maxAttempts,
        delayMs: boundedDelay,
        elapsedMs: options.deadline?.elapsedMs(),
        remainingMs: options.deadline?.remainingMs(),
        reason,
      };
      options.onEvent?.(retryEvent);
      publishRetryEvent(retryEvent);
      await sleep(boundedDelay, options.signal);
    }
  }
  const exhaustedEvent: RetryTelemetryEvent = {
    phase: options.phase,
    event: 'exhausted',
    attempt: merged.maxAttempts,
    maxAttempts: merged.maxAttempts,
    elapsedMs: options.deadline?.elapsedMs(),
    remainingMs: options.deadline?.remainingMs(),
    reason: options.classifyReason?.(lastError),
  };
  options.onEvent?.(exhaustedEvent);
  publishRetryEvent(exhaustedEvent);
  if (lastError) throw lastError;
  throw new AppError('COMMAND_FAILED', 'retry failed');
}

function computeDelay(base: number, max: number, jitter: number, attempt: number): number {
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  const jitterAmount = exp * jitter;
  return Math.max(0, exp + (Math.random() * 2 - 1) * jitterAmount);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    };
    const timer = setTimeout(finish, ms);

    function onAbort(): void {
      clearTimeout(timer);
      finish();
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function publishRetryEvent(event: RetryTelemetryEvent): void {
  emitDiagnostic({
    level: event.event === 'attempt_failed' || event.event === 'exhausted' ? 'warn' : 'debug',
    phase: 'retry',
    data: {
      ...event,
    },
  });
}
