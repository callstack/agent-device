// Deterministic, seed-driven cooperative scheduler for the concurrency torture
// lane (#1416).
//
// Why this exists (issue review amendment, 2026-07-27): a seed alone does NOT
// reproduce Promise/event-loop interleavings. This is the "instrumented task
// queue / controlled dispatcher" the amendment requires — the single source of
// concurrency ordering in the harness. Every client runs as a *fiber* that only
// makes progress when the scheduler resumes it, and mutual exclusion between
// fibers is granted by the scheduler too (an integrated mutex). A given seed
// therefore fully determines execution order: which fiber steps next, and which
// waiter wins a contended lock.
//
// Design contract that makes this deterministic:
//   - Fibers yield ONLY through scheduler-owned promises (`step`, `acquire`).
//   - Everything a fiber does between yields is synchronous (the harness drives
//     the real in-memory `SessionStore` / `LeaseRegistry`, which never await),
//     so exactly one park-or-completion happens per resumed turn.
//   - No wall clock, no timers, no real I/O: the microtask queue only ever holds
//     continuations the scheduler itself resolved.
//
// See docs/agents/testing.md ("Concurrency torture lane") for the seed-replay
// flag and how failures are reproduced.

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A lock key the harness serializes on, mirroring `RequestExecutionLockKey`. */
export type LockKey = `session:${string}` | `device:${string}`;

/** The controls a fiber uses to cooperate with the scheduler. */
export type Fiber = {
  readonly id: number;
  readonly name: string;
  /** Yield a scheduling point; resolves when the scheduler next steps this fiber. */
  step(label?: string): Promise<void>;
  /** Acquire the mutex for `key`, parking (seed-ordered) until it is granted. */
  acquire(key: LockKey): Promise<void>;
  /** Release a mutex this fiber holds. */
  release(key: LockKey): void;
  /** Run `task` while holding `key`, releasing on completion or throw. */
  withLock<T>(key: LockKey, task: () => Promise<T>): Promise<T>;
};

type Mutex = {
  holder: number | null;
  readonly waiters: Set<number>;
};

/** One scheduler decision, recorded so a failing interleaving can be printed. */
export type SchedulerChoice =
  | { kind: 'step'; fiber: number; label?: string }
  | { kind: 'grant'; fiber: number; key: LockKey };

/** Serialize a decision trace to a canonical string for exact replay comparison. */
export function serializeTrace(trace: readonly SchedulerChoice[]): string {
  return trace
    .map((choice) =>
      choice.kind === 'step'
        ? `s:${choice.fiber}:${choice.label ?? ''}`
        : `g:${choice.fiber}:${choice.key}`,
    )
    .join('|');
}

export class SchedulerDeadlockError extends Error {
  readonly liveFibers: readonly number[];
  readonly heldLocks: readonly { key: LockKey; holder: number; waiters: number[] }[];

  constructor(
    message: string,
    liveFibers: readonly number[],
    heldLocks: readonly { key: LockKey; holder: number; waiters: number[] }[],
  ) {
    super(message);
    this.name = 'SchedulerDeadlockError';
    this.liveFibers = liveFibers;
    this.heldLocks = heldLocks;
  }
}

export class DeterministicScheduler {
  private readonly pickIndex: (bound: number) => number;
  private readonly mutexes = new Map<LockKey, Mutex>();
  private readonly wake = new Map<number, () => void>();
  private readonly readySteppers = new Set<number>();
  private readonly stepLabels = new Map<number, string | undefined>();
  private readonly liveFibers = new Set<number>();
  private readonly fiberNames = new Map<number, string>();
  private turn: Deferred<void> | null = null;
  private firstError: unknown;
  private readonly choiceLog: SchedulerChoice[] = [];
  // How many times acquiring a key had to PARK because it was already held —
  // i.e. genuine contention actually occurred (not just that a lock was taken).
  private readonly contention = new Map<LockKey, number>();

  constructor(pickIndex: (bound: number) => number) {
    this.pickIndex = pickIndex;
  }

  /** The full ordered decision trace — handy in failure output for replay. */
  get trace(): readonly SchedulerChoice[] {
    return this.choiceLog;
  }

  /** Per-key count of acquisitions that parked on a held lock (observed contention). */
  get contentionByKey(): ReadonlyMap<LockKey, number> {
    return this.contention;
  }

  /**
   * Run every fiber to completion under seeded interleaving. Resolves once all
   * fibers finish; rejects with the first fiber error, or a
   * {@link SchedulerDeadlockError} if the fibers wedge (no runnable candidate
   * while some are still alive).
   */
  async run(
    fibers: readonly { name: string; body: (fiber: Fiber) => Promise<void> }[],
  ): Promise<void> {
    const running = fibers.map((spec, id) => {
      this.liveFibers.add(id);
      this.fiberNames.set(id, spec.name);
      const fiber = this.makeFiber(id, spec.name);
      return spec
        .body(fiber)
        .catch((error: unknown) => {
          this.firstError ??= error;
        })
        .finally(() => {
          this.liveFibers.delete(id);
          this.resolveTurn();
        });
    });

    // Let every fiber run up to its first yield before the first decision.
    await Promise.resolve();

    for (;;) {
      const candidates = this.collectCandidates();
      if (candidates.length === 0) {
        if (this.liveFibers.size === 0) break;
        throw this.deadlock();
      }
      const choice = candidates[this.pickIndex(candidates.length)] as SchedulerChoice;
      this.choiceLog.push(choice);
      this.turn = deferred();
      this.applyChoice(choice);
      await this.turn.promise;
      this.turn = null;
    }

    await Promise.all(running);
    if (this.firstError !== undefined) throw this.firstError;
  }

  /** Assert the run left no lock held and no waiter parked (invariant: locks released). */
  assertQuiescent(): void {
    const stuck = [...this.mutexes.entries()].filter(
      ([, mutex]) => mutex.holder !== null || mutex.waiters.size > 0,
    );
    if (stuck.length > 0) {
      const detail = stuck
        .map(
          ([key, mutex]) => `${key}(holder=${String(mutex.holder)}, waiters=${mutex.waiters.size})`,
        )
        .join(', ');
      throw new Error(`scheduler not quiescent — locks still held/awaited: ${detail}`);
    }
  }

  private makeFiber(id: number, name: string): Fiber {
    const step = (label?: string): Promise<void> => {
      const gate = deferred<void>();
      this.wake.set(id, gate.resolve);
      this.stepLabels.set(id, label);
      this.readySteppers.add(id);
      this.resolveTurn();
      return gate.promise;
    };
    const acquire = (key: LockKey): Promise<void> => {
      const mutex = this.mutexFor(key);
      if (mutex.holder === null && mutex.waiters.size === 0) {
        // Uncontended: take it immediately and keep running this turn. Which
        // fiber reaches a free lock first is already a seeded decision (the
        // scheduler chose to step it), so no extra decision is needed here.
        mutex.holder = id;
        return Promise.resolve();
      }
      const gate = deferred<void>();
      this.wake.set(id, gate.resolve);
      mutex.waiters.add(id);
      this.contention.set(key, (this.contention.get(key) ?? 0) + 1);
      this.resolveTurn();
      return gate.promise;
    };
    const release = (key: LockKey): void => {
      const mutex = this.mutexFor(key);
      if (mutex.holder !== id) {
        throw new Error(
          `fiber ${name} released ${key} it does not hold (holder=${String(mutex.holder)})`,
        );
      }
      mutex.holder = null;
    };
    const withLock = async <T>(key: LockKey, task: () => Promise<T>): Promise<T> => {
      await acquire(key);
      try {
        return await task();
      } finally {
        release(key);
      }
    };
    return { id, name, step, acquire, release, withLock };
  }

  private collectCandidates(): SchedulerChoice[] {
    const candidates: SchedulerChoice[] = [];
    for (const fiber of this.readySteppers) {
      candidates.push({ kind: 'step', fiber, label: this.stepLabels.get(fiber) });
    }
    for (const [key, mutex] of this.mutexes) {
      if (mutex.holder === null && mutex.waiters.size > 0) {
        for (const fiber of mutex.waiters) {
          candidates.push({ kind: 'grant', fiber, key });
        }
      }
    }
    return candidates;
  }

  private applyChoice(choice: SchedulerChoice): void {
    if (choice.kind === 'step') {
      this.readySteppers.delete(choice.fiber);
      this.stepLabels.delete(choice.fiber);
    } else {
      const mutex = this.mutexFor(choice.key);
      mutex.waiters.delete(choice.fiber);
      mutex.holder = choice.fiber;
    }
    const wake = this.wake.get(choice.fiber);
    this.wake.delete(choice.fiber);
    wake?.();
  }

  private mutexFor(key: LockKey): Mutex {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = { holder: null, waiters: new Set() };
      this.mutexes.set(key, mutex);
    }
    return mutex;
  }

  private resolveTurn(): void {
    this.turn?.resolve();
  }

  private deadlock(): SchedulerDeadlockError {
    const heldLocks = [...this.mutexes.entries()]
      .filter(([, mutex]) => mutex.holder !== null || mutex.waiters.size > 0)
      .map(([key, mutex]) => ({
        key,
        holder: mutex.holder ?? -1,
        waiters: [...mutex.waiters],
      }));
    const live = [...this.liveFibers];
    const named = live.map((id) => `${id}:${this.fiberNames.get(id) ?? '?'}`).join(', ');
    return new SchedulerDeadlockError(
      `scheduler wedged with live fibers [${named}] and no runnable candidate — probable lock-order deadlock`,
      live,
      heldLocks,
    );
  }
}
