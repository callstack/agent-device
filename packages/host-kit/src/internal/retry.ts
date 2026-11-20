import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from './diagnostics.ts';

type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
};

/** The diagnostic phase of each retry attempt and outcome. */
export const RETRY_PHASE = 'retry';

/**
 * The read side of a deadline. Holders are typed against this rather than the class so a caller
 * can hand one a substitute clock; {@link Deadline} is the production implementation.
 */
export type DeadlineClock = {
  remainingMs(nowMs?: number): number;
  elapsedMs(nowMs?: number): number;
  isExpired(nowMs?: number): boolean;
};

type RetryAttemptContext = {
  attempt: number;
  maxAttempts: number;
  deadline?: DeadlineClock;
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

type RetryOptions = {
  deadline?: DeadlineClock;
  phase?: string;
  signal?: AbortSignal;
  classifyReason?: (error: unknown) => string | undefined;
  onEvent?: (event: RetryTelemetryEvent) => void;
  /**
   * One-shot evidence that the dependency's startup state changed. It can wake the current retry
   * delay, but never skips an attempt or changes the retry/deadline policy. The next attempt remains
   * the authority on whether the dependency is usable.
   */
  retryWakeSignal?: AbortSignal;
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

export class Deadline implements DeadlineClock {
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

// fallow-ignore-next-line complexity
export async function retryWithPolicy<T>(
  fn: (context: RetryAttemptContext) => Promise<T>,
  policy: Partial<RetryPolicy> = {},
  options: RetryOptions = {},
): Promise<T> {
  const merged: RetryPolicy = {
    maxAttempts: policy.maxAttempts ?? defaultOptions.maxAttempts,
    baseDelayMs: policy.baseDelayMs ?? defaultOptions.baseDelayMs,
    maxDelayMs: policy.maxDelayMs ?? defaultOptions.maxDelayMs,
    jitter: policy.jitter ?? defaultOptions.jitter,
    shouldRetry: policy.shouldRetry,
  };
  let retryWakeSignalConsumed = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= merged.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw createRequestCanceledError();
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
    } catch (error) {
      lastError = error;
      const reason = options.classifyReason?.(error);
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
      if (merged.shouldRetry && !merged.shouldRetry(error, attempt)) break;
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
      if (options.retryWakeSignal && !retryWakeSignalConsumed) {
        const wakeReason = await waitForRetryDelay(
          boundedDelay,
          options.signal,
          options.retryWakeSignal,
        );
        retryWakeSignalConsumed = wakeReason === 'signaled';
      } else {
        await sleep(boundedDelay, options.signal);
      }
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

/**
 * Samples `probe` until `settled` accepts a value or `deadline` expires, and returns the last value
 * either way so the caller owns its failure. The first sample is always taken, and the last sleep is
 * clamped to the deadline, so a final sample lands at the deadline rather than an interval past it.
 * An aborted `signal` throws the request-canceled error before the next sample.
 */
export async function pollUntilSettled<T>(params: {
  probe: () => Promise<T>;
  settled: (value: T, previous: T | undefined) => boolean;
  deadline: DeadlineClock;
  intervalMs: number;
  signal?: AbortSignal;
}): Promise<Readonly<{ settled: boolean; value: T }>> {
  const { probe, settled, deadline, intervalMs, signal } = params;
  let previous: T | undefined;
  for (;;) {
    if (signal?.aborted) throw createRequestCanceledError();
    const value = await probe();
    if (settled(value, previous)) return { settled: true, value };
    const remainingMs = deadline.remainingMs();
    if (remainingMs <= 0) return { settled: false, value };
    previous = value;
    await sleep(Math.min(intervalMs, remainingMs), signal);
  }
}

function waitForRetryDelay(
  ms: number,
  signal: AbortSignal | undefined,
  retryWakeSignal: AbortSignal,
): Promise<'delay' | 'signaled'> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: 'delay' | 'signaled') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      retryWakeSignal.removeEventListener('abort', onRetryWake);
      resolve(reason);
    };
    const timer = setTimeout(() => finish('delay'), ms);
    const onAbort = () => finish('delay');
    const onRetryWake = () => finish('signaled');
    signal?.addEventListener('abort', onAbort, { once: true });
    retryWakeSignal.addEventListener('abort', onRetryWake, { once: true });
    if (signal?.aborted) {
      finish('delay');
      return;
    }
    if (retryWakeSignal.aborted) finish('signaled');
  });
}

function computeDelay(base: number, max: number, jitter: number, attempt: number): number {
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  const jitterAmount = exp * jitter;
  return Math.max(0, exp + (Math.random() * 2 - 1) * jitterAmount);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
    phase: RETRY_PHASE,
    data: {
      ...event,
    },
  });
}

// --- Request scope ---------------------------------------------------------------------------
// One request's share of time: the cutoff its work must respect, and the only place its result may
// be published. A scope replaces a per-site timer, `AbortController` and timer flag: the timer wakes
// blocked work, and `commit` decides publication on the clock, so a result that reaches its caller
// after the cutoff is refused even when no timer callback has run (#4789). It lives beside
// `Deadline` because the entry surfaces that bound work already evaluate this module, and ADR 0027
// holds each of them to the module count of the merge-base.

/**
 * How long a scope may run, and what its expiry reports. `armedMs` is the budget the scope was
 * given, so a typed timeout states the value its owner armed rather than what was left of a longer
 * one (ADR 0010).
 */
export type Limit = {
  maxMs: number;
  expired: (armedMs: number) => Error;
};

/**
 * A deadline with the cancellation it inherits and the releases it owns. Pass one to the work it
 * bounds; nothing here reads an ambient request context.
 */
export interface Scope {
  /** The same scope narrowed to `limit`, for a stage that gets less time than its parent. */
  child(limit?: Limit): Scope;
  /**
   * Seals publication, stops the scope's timer, and runs each deferred release once in reverse
   * order. Every release runs even after one fails; the first failure is thrown once they have.
   */
  close(): Promise<void>;
  /** Publishes `publish`'s result, or aborts and throws when the scope has already ended. */
  commit<T>(publish: () => T): T;
  /** Absolute time on the scope's clock when its work must stop, or Infinity when unbounded. */
  readonly deadline: number;
  /** Records what this scope must release when it closes. */
  defer(release: () => void | Promise<void>): void;
  /**
   * The signal to hand the work. Reading it arms the deadline, so work that blocks on a signal is
   * woken at the cutoff; work that never observes one is stopped by `commit` instead.
   */
  readonly signal: AbortSignal;
}

/**
 * Opens a scope. `signal` is the cancellation it inherits — a caller's abort, or an enclosing
 * request's — and `limit` bounds its work. Without a `limit` the deadline stays unbounded and the
 * scope carries cancellation and releases only. `now` is the elapsed-time clock the deadline is
 * measured on: pass the clock the budget was measured on, and leave the default `performance.now()`
 * when the caller has none of its own.
 */
export function openScope(signal?: AbortSignal, limit?: Limit, now: () => number = nowMs): Scope {
  return openScopeNode(signal, limit, now, undefined);
}

function nowMs(): number {
  return performance.now();
}

/** Why publication was refused because the scope had already closed. */
class ScopeClosedError extends Error {
  override readonly name = 'ScopeClosedError';

  constructor() {
    super('Request scope is closed');
  }
}

/**
 * The limit that owns a deadline: one per deadline, shared by every scope that inherited it, so
 * expiry runs one error factory once and aborts one controller that all those scopes' signals
 * carry.
 */
type WinningLimit = {
  deadline: number;
  armedMs: number;
  limit: Limit;
  controller: AbortController;
};

type ScopeNode = {
  /** Set when this scope's signal was read, which is when its deadline gets a timer. */
  armed: (() => void) | undefined;
  readonly clock: () => number;
  readonly owning: WinningLimit | undefined;
  readonly parent: ScopeNode | undefined;
  readonly signal: AbortSignal;
  sealed: boolean;
  releases: (() => void | Promise<void>)[];
};

function openScopeNode(
  parentSignal: AbortSignal | undefined,
  limit: Limit | undefined,
  clock: () => number,
  parent: ScopeNode | undefined,
): Scope {
  const inherited = parent?.owning;
  const ownDeadline =
    limit === undefined ? Number.POSITIVE_INFINITY : clock() + Math.max(0, limit.maxMs);
  const wins = limit !== undefined && ownDeadline < (inherited?.deadline ?? Infinity);
  const owning: WinningLimit | undefined = wins
    ? { deadline: ownDeadline, armedMs: limit.maxMs, limit, controller: new AbortController() }
    : inherited;
  const signals = [
    ...(parentSignal ? [parentSignal] : []),
    ...(owning ? [owning.controller.signal] : []),
  ];
  const node: ScopeNode = {
    armed: undefined,
    clock,
    owning,
    parent,
    signal: signals.length === 0 ? new AbortController().signal : AbortSignal.any(signals),
    sealed: false,
    releases: [],
  };

  return {
    get deadline() {
      return node.owning?.deadline ?? Infinity;
    },
    get signal() {
      arm(node);
      return node.signal;
    },
    child: (childLimit) => openScopeNode(node.signal, childLimit, clock, node),
    commit: <T>(publish: () => T): T => {
      throwIfSealed(node);
      // The clock, never a timer callback, is what proves the cutoff has passed. The signal is
      // checked first, so a cancellation the scope inherited stays the reason instead of becoming
      // this scope's timeout.
      if (!node.signal.aborted && expired(node)) expire(node);
      node.signal.throwIfAborted();
      return publish();
    },
    defer: (release) => {
      throwIfSealed(node);
      node.releases.push(release);
    },
    close: async () => {
      // Sealed first, so neither a release nor a task that settles late can publish through it.
      node.sealed = true;
      node.armed?.();
      const releases = node.releases.splice(0, node.releases.length);
      let firstFailure: unknown;
      let failed = false;
      for (const release of releases.reverse()) {
        try {
          await release();
        } catch (error) {
          if (failed) continue;
          failed = true;
          firstFailure = error;
        }
      }
      if (failed) throw firstFailure;
    },
  };
}

/**
 * Points a timer at the deadline without keeping the process alive for it. An expired budget still
 * gets its wake-up: work blocked on the signal has to be released, not left waiting for its caller.
 */
function arm(node: ScopeNode): void {
  const owning = node.owning;
  if (owning === undefined || node.armed !== undefined || node.signal.aborted) return;
  const timer = setTimeout(() => expire(node), Math.max(0, owning.deadline - node.clock()));
  timer.unref();
  node.armed = () => clearTimeout(timer);
}

/**
 * The one expiry operation, reached from both the timer and `commit`: the winning limit's error
 * aborts the controller every scope of this deadline carries, so work in flight and the caller that
 * waits for it see one cause. Each caller judges the moment: the timer fires once the armed
 * duration has run, and `commit` reads the clock.
 */
function expire(node: ScopeNode): void {
  const owning = node.owning;
  if (owning === undefined || owning.controller.signal.aborted) return;
  owning.controller.abort(owning.limit.expired(owning.armedMs));
}

/** Whether the clock has passed the deadline this scope runs under. */
function expired(node: ScopeNode): boolean {
  const owning = node.owning;
  return owning !== undefined && owning.deadline <= node.clock();
}

/**
 * Whether this scope, or one that bounds it, has closed. Sealing travels down the chain and never
 * up: closing one stage of a request must not seal the request.
 */
function throwIfSealed(node: ScopeNode): void {
  for (let current: ScopeNode | undefined = node; current; current = current.parent) {
    if (current.sealed) throw new ScopeClosedError();
  }
}
