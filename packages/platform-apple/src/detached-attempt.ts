/**
 * Work that has to outlive the request that started it.
 *
 * A capture that gives up on a slow probe or build must not take that work down with it: the next
 * capture wants the same result, and on a cold host the cost is host setup rather than request work
 * (#2491). So one attempt runs per key, detached from whoever started it, and every caller that
 * arrives while it runs is answered from that attempt instead of launching a second one.
 *
 * What each owner declares — rather than re-implements — is how long a caller may wait for an
 * attempt (`waitMs`), whether every waiting caller may spend that budget or only the first one to
 * arrive (`waitGrant`), how long a failed attempt keeps being answered as-is before another attempt
 * starts (`retryAfterMs`, omitted for work worth retrying at once), and what an attempt that is
 * still running costs the caller (`pending`). A settled success leaves the table, because only the
 * owner knows when its value stops being valid; that owner caches it and invalidates it on its own
 * terms. `close()` is for owners with a lifecycle: it aborts the running attempts so a build or
 * probe cannot outlive the source that started it.
 */

export type DetachedAttempts<Value> = Readonly<{
  /**
   * The value for `key`, starting a detached attempt when none is running or the last failure is
   * old enough to retry. Resolves when the attempt is ready, throws its failure, or throws
   * `pending()` when it is still running once this caller's wait is spent.
   */
  value(
    key: string,
    params: Readonly<{
      /** Called only when no attempt is running; must honour `signal` for `close()` to reach it. */
      start: (signal: AbortSignal) => Promise<Value>;
      /**
       * Sleeps inside the caller's own deadline, so a client abort rejects this call with the
       * caller's typed cancellation instead of reporting a fresh `pending`.
       *
       * `stop` is aborted as soon as this caller has its answer from somewhere else; the wait has to
       * release its timer and listeners then and resolve, since nobody is racing it any more.
       */
      wait: (waitMs: number, stop: AbortSignal) => Promise<void>;
      pending: () => Error;
    }>,
  ): Promise<Value>;
  /** Aborts every running attempt and forgets all of them. */
  close(): void;
}>;

/** Whether a caller that arrives while an attempt runs may wait for it. */
export type DetachedAttemptWaitGrant =
  /** Each caller spends the wait budget, for work measured in seconds that every caller would
   *  rather wait out than give up on. */
  | 'every-caller'
  /** Only the first caller to arrive spends it, for work that outlives any one capture: a poll
   *  loop that has already paid the budget once should not pay it again per poll (#2491). */
  | 'first-caller';

type Attempt<Value> = {
  status: 'pending' | 'ready' | 'failed';
  value: Value;
  error: unknown;
  /** When the attempt stopped being pending. A retry window is measured from here, so an attempt
   *  that failed late is not already eligible for a retry the moment it fails. */
  settledAtMs: number;
  waitSpent: boolean;
  controller: AbortController;
  settled: Promise<void>;
};

/**
 * The wait an owner hands to `value()`, built once so the promise every owner needs is the promise
 * this module describes: sleeps `waitMs`, resolves when that sleep is spent or when `stop` says the
 * answer arrived elsewhere, and rejects only on the caller's own abort so that stays typed.
 *
 * Every listener this adds to a signal it did not create is removed once the wait settles, on every
 * path (timeout, `stop`, or the caller's own abort) — `stop` is optional for a caller with no signal
 * to end the wait early.
 */
export function waitForDetachedAttempt(
  params: Readonly<{
    waitMs: number;
    /** The caller's own deadline signal; a wait inside it keeps a client abort a client abort. */
    signal: AbortSignal | undefined;
    stop: AbortSignal | undefined;
    /** The rejection for the caller aborting, so each owner keeps its own error type. */
    cancelled: () => unknown;
  }>,
): Promise<void> {
  const { waitMs, signal, stop, cancelled } = params;
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => finish(() => reject(cancelled()));
    const onStop = () => finish(resolve);
    const timer = setTimeout(() => finish(resolve), waitMs);
    function finish(settle: () => void): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stop?.removeEventListener('abort', onStop);
      settle();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    stop?.addEventListener('abort', onStop, { once: true });
    if (signal?.aborted) onAbort();
    else if (stop?.aborted) onStop();
  });
}

export function createDetachedAttempts<Value>(
  deps: Readonly<{
    waitMs: number;
    waitGrant?: DetachedAttemptWaitGrant;
    retryAfterMs?: number;
    /** The clock the retry window is measured against; injected so a test can move time. */
    now?: () => number;
  }>,
): DetachedAttempts<Value> {
  const now = deps.now ?? Date.now;
  const waitGrant = deps.waitGrant ?? 'every-caller';
  const attempts = new Map<string, Attempt<Value>>();

  const startAttempt = (
    key: string,
    start: (signal: AbortSignal) => Promise<Value>,
  ): Attempt<Value> => {
    const attempt: Attempt<Value> = {
      status: 'pending',
      value: undefined as Value,
      error: undefined,
      settledAtMs: now(),
      waitSpent: false,
      controller: new AbortController(),
      settled: undefined as unknown as Promise<void>,
    };
    let settle = () => {};
    attempt.settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    attempts.set(key, attempt);
    const finish = (status: 'ready' | 'failed', outcome: Value | unknown) => {
      attempt.status = status;
      if (status === 'ready') attempt.value = outcome as Value;
      else attempt.error = outcome;
      attempt.settledAtMs = now();
      // A success is the owner's to cache, because only the owner knows when the value stops being
      // valid. A failure stays only as long as it should keep being answered as-is.
      if (status === 'ready' || deps.retryAfterMs === undefined) {
        if (attempts.get(key) === attempt) attempts.delete(key);
      }
      settle();
    };
    // The attempt outlives every caller that asked for it, so a rejection nobody is awaiting yet
    // must never surface as an unhandled rejection; later callers read it from the record.
    try {
      void start(attempt.controller.signal).then(
        (value) => finish('ready', value),
        (error: unknown) => finish('failed', error),
      );
    } catch (error) {
      finish('failed', error);
    }
    return attempt;
  };

  const currentAttempt = (
    key: string,
    start: (signal: AbortSignal) => Promise<Value>,
  ): Attempt<Value> => {
    const attempt = attempts.get(key);
    if (!attempt) return startAttempt(key, start);
    if (attempt.status !== 'failed') return attempt;
    const failedAgoMs = now() - attempt.settledAtMs;
    if (deps.retryAfterMs === undefined || failedAgoMs >= deps.retryAfterMs) {
      return startAttempt(key, start);
    }
    return attempt;
  };

  return {
    value: async (key, params) => {
      const attempt = currentAttempt(key, params.start);
      if (attempt.status === 'pending' && (waitGrant === 'every-caller' || !attempt.waitSpent)) {
        // Marked before waiting: two captures arriving together must not each spend the budget.
        attempt.waitSpent = true;
        const stopWaiting = new AbortController();
        const waiting = params.wait(deps.waitMs, stopWaiting.signal);
        // A wait can still reject after it lost the race, e.g. a client aborting in the moment
        // between the attempt settling and this call returning; nobody awaits it by then.
        waiting.catch(() => {});
        try {
          await Promise.race([attempt.settled, waiting]);
        } finally {
          stopWaiting.abort();
        }
      }
      if (attempt.status === 'ready') return attempt.value;
      if (attempt.status === 'failed') throw attempt.error;
      throw params.pending();
    },
    close: () => {
      const running = [...attempts.values()];
      attempts.clear();
      for (const attempt of running) attempt.controller.abort();
    },
  };
}
