/**
 * The one observation loop: capture until a verdict accepts, on a schedule, under a budget. Owns
 * cadence, the deadline, and the per-poll timeline. Owns nothing about WHAT is observed: the verdict
 * is the caller's, and so is the equality rule behind it (digest, signature, pixel).
 */

export type ObservationSchedule = Readonly<{
  /** Delay between polls, clamped to the remaining budget. */
  intervalMs: number;
  /**
   * Wall-clock budget from the first capture. It bounds when a poll may start; a capture that
   * finishes past it is still judged. The sample after the last sleep is always taken, so a verdict
   * that reads elapsed time against a cap sees a poll at or past it.
   */
  budgetMs: number;
  /** Observations (an `initial` counts) the loop always completes before the budget may end it. */
  minPolls?: number;
}>;

export type ObservationClock = Readonly<{
  now(): number;
  sleep(ms: number): Promise<void>;
}>;

export type ObservationVerdict<R> =
  | Readonly<{ kind: 'done'; result: R }>
  /** Keep polling; `budgetMs` raises the budget measured from the first capture (never lowers it). */
  | Readonly<{ kind: 'continue'; budgetMs?: number }>;

export type ObservationPoll = Readonly<{
  startedMs: number;
  durationMs: number;
  outcome: 'observed' | 'failed';
}>;

export type ObservationEvidence = Readonly<{
  polls: readonly ObservationPoll[];
  waitedMs: number;
}>;

/**
 * How an observation loop ended: `done` when the verdict accepted a capture, `expired` when the
 * budget ran out while the verdict still said continue, `failed` when a capture threw.
 */
type ObservedEnd<T, R> =
  | Readonly<{ kind: 'done'; result: R; value: T }>
  | Readonly<{ kind: 'expired'; last: T | undefined }>
  | Readonly<{ kind: 'failed'; last: T | undefined; error: unknown }>;

export type Observed<T, R> = ObservationEvidence & ObservedEnd<T, R>;

export type ObserveUntilParams<T, R> = Readonly<{
  capture: () => Promise<T>;
  /** Judges the latest capture; `previous` is the last observed value, for quiet-pair predicates. */
  verdict: (latest: T, previous: T | undefined, polls: number) => ObservationVerdict<R>;
  schedule: ObservationSchedule;
  clock?: ObservationClock;
  /** A capture the caller already holds; judged first, without a poll. */
  initial?: T;
}>;

const REAL_CLOCK: ObservationClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type LoopState<T> = {
  readonly startedMs: number;
  budgetMs: number;
  observations: number;
  readonly polls: ObservationPoll[];
  previous: T | undefined;
  last: T | undefined;
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
  const loop: Loop<T, R> = {
    params,
    clock,
    state: {
      startedMs: clock.now(),
      budgetMs: params.schedule.budgetMs,
      observations: 0,
      polls: [],
      previous: undefined,
      last: undefined,
    },
  };
  if (params.initial !== undefined) {
    loop.state.observations += 1;
    const done = judge(loop, params.initial);
    if (done) return done;
  }
  while (true) {
    const expired = await waitBeforePoll(loop);
    if (expired) return expired;
    const ended = await pollOnce(loop);
    if (ended) return ended;
  }
}

function remainingMs<T, R>({ state, clock }: Loop<T, R>): number {
  return state.startedMs + state.budgetMs - clock.now();
}

function mustPoll<T, R>({ params, state }: Loop<T, R>): boolean {
  return state.observations < (params.schedule.minPolls ?? 1);
}

/** Sleeps one interval between observations; ends the loop when the budget is spent first. */
async function waitBeforePoll<T, R>(loop: Loop<T, R>): Promise<Observed<T, R> | undefined> {
  const { state, clock, params } = loop;
  if (state.observations === 0) return undefined;
  const forced = mustPoll(loop);
  if (!forced && remainingMs(loop) <= 0) return finish(loop, { kind: 'expired', last: state.last });
  const { intervalMs } = params.schedule;
  await clock.sleep(forced ? intervalMs : Math.max(0, Math.min(intervalMs, remainingMs(loop))));
  return undefined;
}

async function pollOnce<T, R>(loop: Loop<T, R>): Promise<Observed<T, R> | undefined> {
  const { params, clock, state } = loop;
  const pollStartedMs = clock.now();
  const record = (outcome: ObservationPoll['outcome']) => {
    state.observations += 1;
    state.polls.push({
      startedMs: pollStartedMs - state.startedMs,
      durationMs: clock.now() - pollStartedMs,
      outcome,
    });
  };
  let value: T;
  try {
    value = await params.capture();
  } catch (error) {
    record('failed');
    return finish(loop, { kind: 'failed', last: state.last, error });
  }
  record('observed');
  return judge(loop, value);
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
  const { state, clock } = loop;
  return { ...end, polls: state.polls, waitedMs: clock.now() - state.startedMs };
}
