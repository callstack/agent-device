import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

/**
 * The one observation loop: capture until a verdict accepts, on a schedule, under a budget. Owns
 * cadence, the deadline, abort-and-join of an in-flight capture under `captureDeadline: 'cancel'`,
 * which capture errors are ridden out, and the per-poll timeline. Owns nothing about WHAT is
 * observed: the verdict is the caller's, and so is the equality rule behind it (digest, signature,
 * pixel).
 */

/**
 * How an observation loop ended.
 *
 * - `done` — the verdict accepted a capture.
 * - `expired` — the budget ran out while the verdict still said continue.
 * - `stalled` — a capture was still in flight at its deadline; it was cancelled and joined, so no
 *   late result can mutate state after the loop returned.
 * - `failed` — a capture error the loop does not ride out.
 */
export type ObservationEnd = 'done' | 'expired' | 'stalled' | 'failed';

export type ObservationSchedule = Readonly<{
  /** Delay between polls, clamped to the remaining budget. */
  intervalMs: number;
  /**
   * Wall-clock budget from the first capture. It bounds when a poll may start; under
   * `captureDeadline: 'cancel'` a capture that starts inside it may overrun it by at most one
   * interval. The sample after the last sleep is always taken, so a verdict that reads elapsed time
   * against a cap sees a poll at or past it.
   */
  budgetMs: number;
  /** Observations (an `initial` counts) the loop always completes before the budget may end it. */
  minPolls?: number;
  /**
   * `'start'` (default) bounds every capture, the first included. `'first-capture'` leaves the first
   * capture unbounded and spends the budget only on retries, so a caller whose first attempt is a
   * one-shot pays nothing on its success path.
   */
  budgetFrom?: 'start' | 'first-capture';
  /**
   * Whether a capture is bounded by its own deadline. `'cancel'` arms each capture with the
   * remaining budget (at least one interval) as an abort signal, and a capture that ends at or past
   * that deadline ends the loop `stalled`: declare it only when the capture honors the signal.
   * `'none'` hands the capture no deadline; a capture that finishes past the budget is still judged,
   * so the loop ends `done` on an accepting verdict and `expired` otherwise. Default `'none'`, so a
   * capture that ignores the signal cannot end the loop `stalled` by omission.
   */
  captureDeadline?: 'cancel' | 'none';
}>;

export type ObservationClock = Readonly<{
  now(): number;
  sleep(ms: number): Promise<void>;
}>;

export type ObservationVerdict<R> =
  | Readonly<{ kind: 'done'; result: R }>
  /** Keep polling; `budgetMs` raises the budget measured from the first capture (never lowers it). */
  | Readonly<{ kind: 'continue'; budgetMs?: number }>;

/** `failed` is a capture error the loop does not ride out; it always ends the loop. */
export type ObservationPollOutcome = 'observed' | 'rode-out' | 'stalled' | 'failed';

export type ObservationPoll = Readonly<{
  startedMs: number;
  durationMs: number;
  outcome: ObservationPollOutcome;
}>;

export type ObservationEvidence = Readonly<{
  polls: readonly ObservationPoll[];
  waitedMs: number;
}>;

type ObservedEnd<T, R> =
  | Readonly<{ kind: 'done'; result: R; value: T }>
  | Readonly<{ kind: 'expired'; last: T | undefined; lastError: unknown }>
  | Readonly<{ kind: 'stalled'; last: T | undefined; lastError: unknown; error: unknown }>
  | Readonly<{ kind: 'failed'; last: T | undefined; error: unknown }>;

export type Observed<T, R> = ObservationEvidence & ObservedEnd<T, R>;

export type ObserveUntilParams<T, R> = Readonly<{
  capture: (signal: AbortSignal) => Promise<T>;
  /** Judges the latest capture; `previous` is the last observed value, for quiet-pair predicates. */
  verdict: (latest: T, previous: T | undefined, polls: number) => ObservationVerdict<R>;
  schedule: ObservationSchedule;
  /**
   * True keeps polling past this capture error. Default: no error is ridden out. The last
   * ridden-out error is reported as `lastError` when the loop expires or stalls.
   */
  rideOut?: (error: unknown) => boolean;
  signal?: AbortSignal;
  clock?: ObservationClock;
  /** A capture the caller already holds; judged first, without a poll. */
  initial?: T;
  /** Diagnostic phase for the end-of-loop line; nothing is logged without it. */
  phase?: string;
}>;

const REAL_CLOCK: ObservationClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type LoopState<T> = {
  readonly startedMs: number;
  budgetStartedMs: number;
  budgetMs: number;
  observations: number;
  readonly polls: ObservationPoll[];
  previous: T | undefined;
  last: T | undefined;
  lastError: unknown;
};

type Loop<T, R> = Readonly<{
  params: ObserveUntilParams<T, R>;
  clock: ObservationClock;
  state: LoopState<T>;
}>;

export async function observeUntil<T, R>(
  params: ObserveUntilParams<T, R>,
): Promise<Observed<T, R>> {
  const clock = params.clock ?? REAL_CLOCK;
  const startedMs = clock.now();
  const loop: Loop<T, R> = {
    params,
    clock,
    state: {
      startedMs,
      budgetStartedMs: startedMs,
      budgetMs: params.schedule.budgetMs,
      observations: 0,
      polls: [],
      previous: undefined,
      last: undefined,
      lastError: undefined,
    },
  };
  if (params.initial !== undefined) {
    loop.state.observations += 1;
    const done = judge(loop, params.initial);
    if (done) return done;
  }
  while (true) {
    if (params.signal?.aborted) throw createRequestCanceledError();
    const expired = await waitBeforePoll(loop);
    if (expired) return expired;
    if (params.signal?.aborted) throw createRequestCanceledError();
    const ended = await pollOnce(loop);
    if (ended) return ended;
  }
}

function remainingMs<T, R>({ state, clock }: Loop<T, R>): number {
  return state.budgetStartedMs + state.budgetMs - clock.now();
}

function mustPoll<T, R>({ params, state }: Loop<T, R>): boolean {
  return state.observations < (params.schedule.minPolls ?? 1);
}

/** Sleeps one interval between observations; ends the loop when the budget is spent first. */
async function waitBeforePoll<T, R>(loop: Loop<T, R>): Promise<Observed<T, R> | undefined> {
  const { state, clock, params } = loop;
  if (state.observations === 0) return undefined;
  const forced = mustPoll(loop);
  if (!forced && remainingMs(loop) <= 0)
    return finish(loop, { kind: 'expired', last: state.last, lastError: state.lastError });
  const { intervalMs } = params.schedule;
  await clock.sleep(forced ? intervalMs : Math.max(0, Math.min(intervalMs, remainingMs(loop))));
  return undefined;
}

async function pollOnce<T, R>(loop: Loop<T, R>): Promise<Observed<T, R> | undefined> {
  const { params, clock, state } = loop;
  const unbounded = params.schedule.budgetFrom === 'first-capture' && state.polls.length === 0;
  const pollStartedMs = clock.now();
  const bounded = !unbounded && params.schedule.captureDeadline === 'cancel';
  const poll = await captureWithin(
    bounded ? Math.max(remainingMs(loop), params.schedule.intervalMs) : undefined,
    params.signal,
    params.capture,
    clock,
  );
  state.observations += 1;
  if (unbounded) state.budgetStartedMs = clock.now();
  const outcome = pollOutcome(loop, poll);
  state.polls.push({
    startedMs: pollStartedMs - state.startedMs,
    durationMs: clock.now() - pollStartedMs,
    outcome,
  });
  if (poll.kind === 'observed') return judge(loop, poll.value);
  if (outcome === 'rode-out') {
    state.lastError = poll.error;
    return undefined;
  }
  if (poll.kind === 'stalled') {
    return finish(loop, {
      kind: 'stalled',
      last: state.last,
      lastError: state.lastError,
      error: poll.error,
    });
  }
  return finish(loop, { kind: 'failed', last: state.last, error: poll.error });
}

function pollOutcome<T, R>(
  loop: Loop<T, R>,
  poll: CaptureWithinOutcome<T>,
): ObservationPollOutcome {
  if (poll.kind === 'stalled') return 'stalled';
  if (poll.kind === 'failed') return loop.params.rideOut?.(poll.error) ? 'rode-out' : 'failed';
  return 'observed';
}

function judge<T, R>(loop: Loop<T, R>, value: T): Observed<T, R> | undefined {
  const { params, state } = loop;
  const verdict = params.verdict(value, state.previous, state.polls.length);
  state.previous = value;
  state.last = value;
  if (verdict.kind === 'done') return finish(loop, { kind: 'done', result: verdict.result, value });
  if (verdict.budgetMs !== undefined) state.budgetMs = Math.max(state.budgetMs, verdict.budgetMs);
  return undefined;
}

function finish<T, R>(loop: Loop<T, R>, end: ObservedEnd<T, R>): Observed<T, R> {
  const { params, state, clock } = loop;
  const observed: Observed<T, R> = {
    ...end,
    polls: state.polls,
    waitedMs: clock.now() - state.startedMs,
  };
  if (params.phase) {
    emitDiagnostic({
      level: 'debug',
      phase: params.phase,
      data: {
        end: observed.kind satisfies ObservationEnd,
        polls: state.polls.length,
        waitedMs: observed.waitedMs,
      },
    });
  }
  return observed;
}

type CaptureWithinOutcome<T> =
  | Readonly<{ kind: 'observed'; value: T }>
  | Readonly<{ kind: 'failed'; error: unknown }>
  | Readonly<{ kind: 'stalled'; error: unknown }>;

/**
 * Runs one capture under the remaining budget by cancellation, then waits for it to quiesce.
 * Deliberately not race-and-abandon: a late capture could otherwise mutate session state or keep a
 * platform helper after the loop has returned.
 */
async function captureWithin<T>(
  remainingMs: number | undefined,
  parent: AbortSignal | undefined,
  capture: (signal: AbortSignal) => Promise<T>,
  clock: ObservationClock,
): Promise<CaptureWithinOutcome<T>> {
  const deadline = armDeadline(remainingMs, clock);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  try {
    const value = await capture(signal);
    return endOfCapture(parent, deadline.expired(), undefined) ?? { kind: 'observed', value };
  } catch (error) {
    return endOfCapture(parent, deadline.expired(), error) ?? { kind: 'failed', error };
  } finally {
    deadline.dispose();
  }
}

/** A capture that ended after the deadline stalled; one ended by the caller's signal was canceled. */
function endOfCapture<T>(
  parent: AbortSignal | undefined,
  deadlineExpired: boolean,
  error: unknown,
): CaptureWithinOutcome<T> | undefined {
  if (parent?.aborted) throw createRequestCanceledError();
  return deadlineExpired ? { kind: 'stalled', error } : undefined;
}

/** The deadline has passed once its timer fired or the loop's clock reached it, whichever is first. */
function armDeadline(
  remainingMs: number | undefined,
  clock: ObservationClock,
): {
  signal: AbortSignal;
  expired: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  const deadlineAtMs = remainingMs === undefined ? undefined : clock.now() + remainingMs;
  let fired = false;
  const timer =
    remainingMs === undefined
      ? undefined
      : setTimeout(
          () => {
            fired = true;
            controller.abort(new DOMException('Observation deadline exceeded', 'TimeoutError'));
          },
          Math.max(0, remainingMs),
        );
  timer?.unref();
  return {
    signal: controller.signal,
    expired: () => fired || (deadlineAtMs !== undefined && clock.now() >= deadlineAtMs),
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
