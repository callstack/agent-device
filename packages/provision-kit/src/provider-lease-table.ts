import type { DeviceLease } from '@agent-device/contracts/device';

/**
 * The lease table one cloud device provider runtime serves its lease lifecycle from.
 *
 * A provider rents a billed device per lease. This table owns the rules that decide whether that device
 * is still rented (ADR 0007); the provider supplies start, stop, find-by-lease, and its own errors.
 *
 * Keep this module free of value imports: provider runtimes load it on their construction path.
 */

/** One caller's patience: the signal it cancels with, and the epoch-ms instant it stops waiting. */
export type ProviderLeaseBudget = Readonly<{ signal?: AbortSignal; deadline?: number }>;

export type ProviderLeaseAllocateOptions<Request> = ProviderLeaseBudget &
  Readonly<{
    /**
     * Refuses to join a start made for `started` when this allocation asks for something else. Throw the
     * refusal; the table calls this before the allocation joins anything.
     */
    requireJoinable?(started: Request): void;
  }>;

export type ProviderLeaseStartControl<Handle> = Readonly<{
  /**
   * Aborts when no caller still waits for the start before it answers, so the provider can abandon it.
   * No single caller's signal or deadline reaches the start: it runs for every caller that joins it.
   */
  signal: AbortSignal;
  /** Epoch-ms by which the start should answer: `startTimeoutMs` after it was sent. */
  deadline: number;
  /**
   * Publishes a rental as soon as the provider can stop it, before the start answers, so a release or a
   * drain can stop a device whose start stalls. A later call with another handle adds a rental; the table
   * stops every one it was told of. Do not publish a handle whose stop could arrive before the provider
   * created the session it names.
   */
  rented(handle: Handle): void;
}>;

/**
 * What one start amounted to. A ready start hands over its session and the handle that stops it. A failed
 * start names in `rented` what it left under rent; omitting it says the start rented nothing beyond what
 * it published through `rented`, which the table still stops. A start that rejects instead is read as one that may
 * have rented, and the table stops the published handle or what `findByLease` names.
 */
export type ProviderLeaseStart<Session, Handle> =
  | Readonly<{ status: 'ready'; session: Session; handle: Handle }>
  | Readonly<{ status: 'failed'; error: unknown; rented?: Handle }>;

/** Which route found a rental still rented, so the provider reports it with the matching details. */
export type ProviderLeaseCleanupScope =
  | Readonly<{ route: 'start' | 'release' | 'recover'; leaseId: string }>
  | Readonly<{ route: 'shutdown' }>;

/**
 * A rental that stays rented, and why. `handle` is absent when the provider could not name the rental,
 * because the start never answered or `findByLease` failed.
 */
export type ProviderUnconfirmedStop<Handle> = Readonly<{
  leaseId: string;
  handle: Handle | undefined;
  cause: unknown;
}>;

export type ProviderLeaseDriver<Session, Handle, Request> = Readonly<{
  /**
   * The longest one start may take to answer. It cuts each caller's wait, and it is how long a teardown
   * waits for a start whose caller already gave up, since only that answer may name the rental.
   */
  startTimeoutMs: number;
  /**
   * How long one teardown waits for a stop to answer. A stop that outlives it is reported as unconfirmed,
   * and the next teardown joins the same stop instead of sending a second one. Unset waits for the answer.
   * Only the stop is bounded here; `findByLease` answers within the provider's own request budget.
   */
  stopTimeoutMs?: number;
  start(
    lease: DeviceLease,
    request: Request,
    control: ProviderLeaseStartControl<Handle>,
  ): Promise<ProviderLeaseStart<Session, Handle>>;
  /** Stops one rental. Resolves only once the provider confirmed the device is no longer rented. */
  stop(handle: Handle): Promise<void>;
  /** Identifies a rental, so one rental is stopped once whichever route named it. */
  handleKey(handle: Handle): string;
  /**
   * Names what a lease rented when the table cannot, as after a daemon restart or a start that rejected.
   * Rejects when the provider cannot name it, which keeps the lease pending for a later retry.
   */
  findByLease(lease: DeviceLease): Promise<Handle>;
  /** The error for an allocation that arrives or finishes while the runtime shuts down. */
  shuttingDown(lease: DeviceLease): Error;
  /** The error for an allocation of a lease that a release, a recovery, or a failed start is ending. */
  releasing(lease: DeviceLease): Error;
  /**
   * The error for a caller that stopped waiting: its signal aborted, or its wait ran out. `caller` is the
   * budget it asked for, and `budgetMs` the wait it was granted after `startTimeoutMs` cut it.
   */
  gaveUp(
    lease: DeviceLease,
    caller: ProviderLeaseBudget,
    budgetMs: number,
    rented: Handle | undefined,
  ): Error;
  /** The error for rentals that stay rented because their stop was not confirmed. */
  cleanupPending(
    unconfirmed: readonly ProviderUnconfirmedStop<Handle>[],
    scope: ProviderLeaseCleanupScope,
    cause?: unknown,
  ): Error;
}>;

/** What a release ended: the stopped handle, and the session it served when the start became ready. */
export type ProviderLeaseReleased<Session, Handle> = Readonly<{
  handle: Handle;
  session: Session | undefined;
}>;

export type ProviderLeaseTable<Session, Handle, Request> = Readonly<{
  /** The ready session a lease holds in this process, while nothing is ending it. */
  live(leaseId: string): Session | undefined;
  /**
   * Rents one device per lease id. A lease that is starting is joined, and one that is ready is reused.
   * Each caller waits within its own budget. A ready device is stopped instead of handed out when no
   * caller is still waiting for it. A lease that something is ending is refused with `releasing`.
   */
  allocate(
    lease: DeviceLease,
    request: Request,
    options?: ProviderLeaseAllocateOptions<Request>,
  ): Promise<Session>;
  /**
   * Ends the lease and forgets it once every rental is confirmed stopped. Resolves `undefined` when this
   * process holds nothing for the lease. Rejects, keeping the lease for a retry, when a rental stays.
   */
  release(leaseId: string): Promise<ProviderLeaseReleased<Session, Handle> | undefined>;
  /** Ends an expired lease, from its entry when this process has one and from `findByLease` otherwise. */
  recover(lease: DeviceLease): Promise<void>;
  /** Refuses new allocations, then ends every lease. Rejects with what stays rented. */
  shutdown(): Promise<void>;
}>;

type Outcome<Session> =
  | Readonly<{ status: 'ready'; session: Session }>
  | Readonly<{ status: 'failed'; error: unknown }>;

/** One rental an entry knows of, and the state of its stop. */
type RentalRecord<Handle> = {
  readonly handle: Handle;
  stopped: boolean;
  /**
   * The stop in flight, which outlives a teardown that stopped waiting for it. It is also the fence that
   * keeps a later rental's stop from overtaking this one, so it is cleared only when the stop settles.
   */
  stopping: Promise<StopFailure | undefined> | undefined;
};

type StopFailure = Readonly<{ cause: unknown }>;

/** One caller waiting for a start, with the budget that decides whether it still wants the device. */
type Waiter = Readonly<{ deadline: number; signal: AbortSignal | undefined }>;

type StartAnswer<Session, Handle> =
  | ProviderLeaseStart<Session, Handle>
  | Readonly<{ status: 'rejected'; error: unknown }>;

type Ended<Session, Handle> =
  | Readonly<{ status: 'stopped'; handle: Handle; session: Session | undefined }>
  | Readonly<{ status: 'nothing-rented' }>
  | Readonly<{ status: 'pending'; owed: readonly Owed<Handle>[] }>;

/** A rental still rented after a teardown, and why; `handle` is absent when nobody could name it. */
type Owed<Handle> = Readonly<{ handle: Handle | undefined; cause: unknown }>;

/**
 * One lease's place in the table, from the moment its start is sent, or its recovery begins, until every
 * rental it knows of is confirmed stopped.
 */
class LeaseEntry<Session, Handle, Request> {
  readonly lease: DeviceLease;
  /** Which entry of its lease id this is; a later entry of the same lease id has a higher one. */
  readonly generation: number;
  /**
   * `starting` until the start answers, `ready` once a waiting caller took its session, `ending` once
   * anything ends the lease. Only `starting` → `ready`, and any phase → `ending`, are allowed.
   */
  phase: 'starting' | 'ready' | 'ending' = 'starting';
  /** What the start was asked for; absent for an entry a recovery opened. */
  readonly request: Request | undefined;
  /** When the start should have answered, and when a teardown stops waiting: `startTimeoutMs` after it was sent. */
  readonly answerBy: number;
  /** Aborted once no caller waits for the start before it answers. */
  readonly abandon = new AbortController();
  /** Settles once the start answered and, for a start that failed, once its teardown settled. */
  start: Promise<Outcome<Session>> = Promise.resolve({ status: 'failed', error: undefined });
  answered = false;
  readonly answer: Promise<void>;
  markAnswered: () => void = () => undefined;
  session: Session | undefined = undefined;
  /** Every rental this lease named, by `handleKey`, in the order named; each stays until stopped. */
  readonly rentals = new Map<string, RentalRecord<Handle>>();
  /** The rental named last, which a report names for the lease. */
  latest: Handle | undefined = undefined;
  /** Whether the lease may hold a rental that nobody could name yet. */
  unnamed = false;
  /** Callers still waiting for the start; one leaves the moment it gives up. */
  readonly waiters = new Set<Waiter>();
  /** Whether a teardown is already queued behind the one in flight. */
  followUpQueued = false;
  /** The one teardown in flight, joined by every release, recovery, and drain. */
  ending: Promise<Ended<Session, Handle>> | undefined = undefined;

  constructor(
    lease: DeviceLease,
    generation: number,
    request: Request | undefined,
    answerBy: number,
  ) {
    this.lease = lease;
    this.generation = generation;
    this.request = request;
    this.answerBy = answerBy;
    this.answer = new Promise((resolve) => {
      this.markAnswered = resolve;
    });
  }
}

export function createProviderLeaseTable<Session, Handle, Request>(
  driver: ProviderLeaseDriver<Session, Handle, Request>,
): ProviderLeaseTable<Session, Handle, Request> {
  const table = new LeaseTable(driver);
  return Object.freeze({
    live: (leaseId: string) => table.live(leaseId),
    allocate: async (
      lease: DeviceLease,
      request: Request,
      options?: ProviderLeaseAllocateOptions<Request>,
    ) => await table.allocate(lease, request, options),
    release: async (leaseId: string) => await table.release(leaseId),
    recover: async (lease: DeviceLease) => await table.recover(lease),
    shutdown: async () => await table.shutdown(),
  });
}

class LeaseTable<Session, Handle, Request> {
  /** An entry leaves only once nothing it rented is still rented. */
  private readonly entries = new Map<string, LeaseEntry<Session, Handle, Request>>();
  private shuttingDown = false;
  private generations = 0;
  private readonly driver: ProviderLeaseDriver<Session, Handle, Request>;

  constructor(driver: ProviderLeaseDriver<Session, Handle, Request>) {
    this.driver = driver;
  }

  live(leaseId: string): Session | undefined {
    const entry = this.entries.get(leaseId);
    return entry?.phase === 'ready' ? entry.session : undefined;
  }

  /** Whether this entry is still its lease id's entry; checked after every await before acting. */
  private isCurrent(entry: LeaseEntry<Session, Handle, Request>): boolean {
    return this.entries.get(entry.lease.leaseId)?.generation === entry.generation;
  }

  async allocate(
    lease: DeviceLease,
    request: Request,
    options: ProviderLeaseAllocateOptions<Request> = {},
  ): Promise<Session> {
    // Nothing between these checks and the entry's registration awaits, so no teardown is missed.
    if (this.shuttingDown) throw this.driver.shuttingDown(lease);
    const existing = this.entries.get(lease.leaseId);
    if (existing?.phase === 'ending') throw this.driver.releasing(lease);
    if (existing?.request !== undefined) options.requireJoinable?.(existing.request);
    const caller = callerBudget(options);
    const timeoutAt = Date.now() + this.driver.startTimeoutMs;
    const deadline = Math.min(caller.deadline ?? timeoutAt, timeoutAt);
    // A caller whose budget is already spent never sends a start that nobody would wait for.
    if (!existing && budgetSpent(caller, deadline)) {
      throw this.driver.gaveUp(lease, caller, 0, undefined);
    }
    const entry = existing ?? this.rent(lease, request, caller, timeoutAt);
    const budgetMs = Math.max(0, deadline - Date.now());
    const outcome = await this.join(entry, caller, deadline);
    return this.deliver(entry, outcome, caller, deadline, budgetMs);
  }

  /** Hands the session to one caller, or says why this caller does not get it. */
  private deliver(
    entry: LeaseEntry<Session, Handle, Request>,
    outcome: Outcome<Session>,
    caller: ProviderLeaseBudget,
    deadline: number,
    budgetMs: number,
  ): Session {
    if (this.shuttingDown) throw this.driver.shuttingDown(entry.lease);
    if (outcome.status === 'failed') throw outcome.error;
    // A release that started while this caller waited owns the device now.
    if (entry.phase !== 'ready' || !this.isCurrent(entry)) throw this.driver.releasing(entry.lease);
    // Checked at delivery, on a fresh start and on reuse alike: the session stays for callers in budget.
    if (budgetSpent(caller, deadline)) {
      throw this.driver.gaveUp(entry.lease, caller, budgetMs, entry.latest);
    }
    return outcome.session;
  }

  async release(leaseId: string): Promise<ProviderLeaseReleased<Session, Handle> | undefined> {
    const entry = this.entries.get(leaseId);
    if (!entry) return undefined;
    const ended = await this.teardown(entry);
    if (ended.status === 'pending') throw this.pending(entry, ended, { route: 'release', leaseId });
    return ended.status === 'stopped'
      ? { handle: ended.handle, session: ended.session }
      : undefined;
  }

  async recover(lease: DeviceLease): Promise<void> {
    const leaseId = lease.leaseId;
    // The daemon forgets a recovered lease once this resolves, so a rental still rented has to reject.
    let entry = this.entries.get(leaseId);
    if (entry === undefined) {
      // A drain that already started would not see a new entry, and the next daemon recovers the lease.
      if (this.shuttingDown) throw this.driver.shuttingDown(lease);
      entry = this.recovering(lease);
    }
    const ended = await this.teardown(entry);
    if (ended.status === 'pending') throw this.pending(entry, ended, { route: 'recover', leaseId });
  }

  async shutdown(): Promise<void> {
    // The fence: from here on, no allocation or recovery registers an entry, so this drain sees all.
    this.shuttingDown = true;
    const unconfirmed: ProviderUnconfirmedStop<Handle>[] = [];
    const entries = [...this.entries.values()];
    const ended = await Promise.all(entries.map(async (entry) => await this.teardown(entry)));
    ended.forEach((outcome, index) => {
      if (outcome.status !== 'pending') return;
      const leaseId = entries[index]!.lease.leaseId;
      for (const owed of outcome.owed) unconfirmed.push({ leaseId, ...owed });
    });
    if (unconfirmed.length > 0) {
      throw this.driver.cleanupPending(unconfirmed, { route: 'shutdown' });
    }
  }

  /** Registers the entry before the first await, so a concurrent allocation or release finds it. */
  private rent(
    lease: DeviceLease,
    request: Request,
    caller: ProviderLeaseBudget,
    answerBy: number,
  ): LeaseEntry<Session, Handle, Request> {
    const entry = new LeaseEntry<Session, Handle, Request>(
      lease,
      (this.generations += 1),
      request,
      answerBy,
    );
    entry.start = this.runStart(entry, request, caller);
    this.entries.set(lease.leaseId, entry);
    return entry;
  }

  /** Registers an entry for a lease this process holds nothing for, so every route joins its teardown. */
  private recovering(lease: DeviceLease): LeaseEntry<Session, Handle, Request> {
    const entry = new LeaseEntry<Session, Handle, Request>(
      lease,
      (this.generations += 1),
      undefined,
      Date.now(),
    );
    entry.answered = true;
    entry.markAnswered();
    entry.unnamed = true;
    entry.phase = 'ending';
    this.entries.set(lease.leaseId, entry);
    return entry;
  }

  /**
   * Runs the start and records what it rented. A ready device goes to the callers still waiting; one
   * nobody waits for, or one a release already owns, is stopped instead. A failed start is torn down
   * before its failure reaches any caller.
   */
  private async runStart(
    entry: LeaseEntry<Session, Handle, Request>,
    request: Request,
    caller: ProviderLeaseBudget,
  ): Promise<Outcome<Session>> {
    const startedAt = Date.now();
    const answer = await this.callStart(entry, request);
    recordAnswer(entry, answer, this.driver.handleKey);
    if (answer.status === 'ready') {
      // Recorded even when nobody takes it, so the teardown reports the device it stopped.
      entry.session = answer.session;
      // The answer may belong to an entry that ended, or was replaced, while the start ran.
      if (entry.phase === 'starting' && this.isCurrent(entry) && stillWanted(entry)) {
        entry.phase = 'ready';
        return { status: 'ready', session: answer.session };
      }
    }
    return await this.endFailedStart(entry, this.startFailure(entry, answer, caller, startedAt));
  }

  /** The start's answer, with a rejection read as an answer that may have rented. */
  private async callStart(
    entry: LeaseEntry<Session, Handle, Request>,
    request: Request,
  ): Promise<StartAnswer<Session, Handle>> {
    try {
      return await this.driver.start(entry.lease, request, {
        signal: entry.abandon.signal,
        deadline: entry.answerBy,
        rented: (handle) => {
          if (entry.answered) return;
          holdRental(entry, handle, this.driver.handleKey(handle));
          if (entry.phase === 'ending') this.followUp(entry);
        },
      });
    } catch (error) {
      return { status: 'rejected', error };
    }
  }

  /** Why a start that hands out no session failed, for the callers still waiting on it. */
  private startFailure(
    entry: LeaseEntry<Session, Handle, Request>,
    answer: StartAnswer<Session, Handle>,
    caller: ProviderLeaseBudget,
    startedAt: number,
  ): unknown {
    if (answer.status !== 'ready') return answer.error;
    if (entry.phase === 'ending') return this.driver.releasing(entry.lease);
    const budgetMs = Math.max(0, entry.answerBy - startedAt);
    return this.driver.gaveUp(entry.lease, caller, budgetMs, answer.handle);
  }

  /**
   * Tears down a start that hands out no session. A release, recovery, or drain that already owns the
   * teardown waits on this answer, so the start only nudges it.
   */
  private async endFailedStart(
    entry: LeaseEntry<Session, Handle, Request>,
    error: unknown,
  ): Promise<Outcome<Session>> {
    if (entry.phase === 'ending') {
      this.followUp(entry);
      return { status: 'failed', error };
    }
    const ended = await this.teardown(entry);
    if (ended.status !== 'pending') return { status: 'failed', error };
    // What is still billed outranks why the start failed, so the report names the rental to end.
    const leaseId = entry.lease.leaseId;
    return {
      status: 'failed',
      error: this.driver.cleanupPending(
        ended.owed.map((owed) => ({ leaseId, ...owed })),
        { route: 'start', leaseId },
        error,
      ),
    };
  }

  /**
   * Waits for the entry's start within this caller's budget. A caller that gives up stops nothing: the
   * device belongs to every caller still waiting.
   */
  private async join(
    entry: LeaseEntry<Session, Handle, Request>,
    caller: ProviderLeaseBudget,
    deadline: number,
  ): Promise<Outcome<Session>> {
    if (entry.phase === 'ready') return { status: 'ready', session: entry.session! };
    const budgetMs = Math.max(0, deadline - Date.now());
    const giveUp = () => this.driver.gaveUp(entry.lease, caller, budgetMs, entry.latest);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), budgetMs);
    // Listened to directly rather than through `AbortSignal.any`, so a long-lived caller signal keeps no
    // link to this entry once the wait is over.
    const signals = caller.signal ? [caller.signal, timeout.signal] : [timeout.signal];
    const waiter: Waiter = { deadline, signal: caller.signal };
    let onAbort = (): void => undefined;
    try {
      entry.waiters.add(waiter);
      if (signals.some((signal) => signal.aborted)) throw giveUp();
      const gaveUp = new Promise<never>((_, reject) => {
        onAbort = () => {
          entry.waiters.delete(waiter);
          this.abandonIfUnwanted(entry);
          reject(giveUp());
        };
        for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([entry.start, gaveUp]);
    } finally {
      entry.waiters.delete(waiter);
      this.abandonIfUnwanted(entry);
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Abandons a start that no caller still waits for. The lease is fenced and torn down in the same step,
   * so a caller that arrives later is refused rather than joining a start that is being given up.
   */
  private abandonIfUnwanted(entry: LeaseEntry<Session, Handle, Request>): void {
    if (entry.answered || entry.abandon.signal.aborted || stillWanted(entry)) return;
    entry.abandon.abort();
    void this.teardown(entry).catch(() => undefined);
  }

  /**
   * The one teardown of an entry, joined by every route that ends it. It fences the entry against
   * allocations in the same step, and it is the only place a rental is stopped or an entry forgotten.
   */
  private teardown(entry: LeaseEntry<Session, Handle, Request>): Promise<Ended<Session, Handle>> {
    entry.phase = 'ending';
    if (entry.ending) return entry.ending;
    const ending = this.runTeardown(entry).finally(() => {
      if (entry.ending === ending) entry.ending = undefined;
    });
    entry.ending = ending;
    return ending;
  }

  private async runTeardown(
    entry: LeaseEntry<Session, Handle, Request>,
  ): Promise<Ended<Session, Handle>> {
    // Each rental is tried at most once per teardown; a later teardown retries what stays owed.
    const tried = new Map<RentalRecord<Handle>, Owed<Handle>>();
    for (;;) {
      await this.untilAnswered(entry);
      const unnamed = await this.nameRental(entry);
      if (unnamed !== undefined) return unnamed;
      const owed = await this.stopRentals(entry, tried);
      if (owed === 'progress') continue;
      if (owed.length > 0) return { status: 'pending', owed };
      // The start may have recorded a rental while the stops above were awaited; look again before
      // forgetting the lease.
      if (entry.unnamed || [...entry.rentals.values()].some((rental) => !rental.stopped)) continue;
      return this.finishTeardown(entry);
    }
  }

  /**
   * Stops the entry's rentals in the order they were named and collects every one still rented. A stop
   * still in flight is never overtaken: a later rental waits for it. A stop that settled unconfirmed does
   * not hold the rest back. Returns `progress` after a confirmed stop, so the caller looks again at a
   * start that may have answered or named another rental meanwhile.
   */
  private async stopRentals(
    entry: LeaseEntry<Session, Handle, Request>,
    tried: Map<RentalRecord<Handle>, Owed<Handle>>,
  ): Promise<readonly Owed<Handle>[] | 'progress'> {
    for (const rental of entry.rentals.values()) {
      if (rental.stopped) continue;
      const earlier = tried.get(rental);
      if (earlier !== undefined) {
        if (rental.stopping !== undefined) break;
        continue;
      }
      const failure = await this.stop(rental);
      if (failure === undefined) return 'progress';
      tried.set(rental, { handle: rental.handle, cause: failure.cause });
      if (rental.stopping !== undefined) break;
    }
    // Every rental still rented is reported, including one that waits behind a stop still in flight.
    return [...entry.rentals.values()]
      .filter((rental) => !rental.stopped)
      .map(
        (rental) =>
          tried.get(rental) ?? {
            handle: rental.handle,
            cause: new Error(
              'The stop waits for an earlier stop of this lease that is still in flight.',
            ),
          },
      );
  }

  /** Asks the provider for a rental this process may hold but cannot name. */
  private async nameRental(
    entry: LeaseEntry<Session, Handle, Request>,
  ): Promise<Ended<Session, Handle> | undefined> {
    if (!entry.unnamed) return undefined;
    try {
      const handle = await this.driver.findByLease(entry.lease);
      holdRental(entry, handle, this.driver.handleKey(handle));
      entry.unnamed = false;
      return undefined;
    } catch (error) {
      return { status: 'pending', owed: [{ handle: undefined, cause: error }] };
    }
  }

  /** Forgets an entry whose rentals are all stopped, unless its start may still rent something. */
  private finishTeardown(entry: LeaseEntry<Session, Handle, Request>): Ended<Session, Handle> {
    const handle = entry.latest;
    if (!entry.answered) {
      // The entry stays for the teardown that the start's answer starts.
      const cause = new Error('The provider start did not answer within its start timeout.');
      return { status: 'pending', owed: [{ handle, cause }] };
    }
    if (this.isCurrent(entry)) this.entries.delete(entry.lease.leaseId);
    return handle === undefined
      ? { status: 'nothing-rented' }
      : { status: 'stopped', handle, session: entry.session };
  }

  /**
   * Runs a teardown that looks at what the start just recorded. A teardown already in flight may have
   * decided before the record, so another one follows it rather than joining it.
   */
  private followUp(entry: LeaseEntry<Session, Handle, Request>): void {
    const current = entry.ending;
    if (current === undefined) {
      void this.teardown(entry).catch(() => undefined);
      return;
    }
    // One queued teardown sees everything recorded before it runs, so more are never chained.
    if (entry.followUpQueued) return;
    entry.followUpQueued = true;
    void current
      .then(async () => {
        entry.followUpQueued = false;
        return await this.teardown(entry);
      })
      .catch(() => undefined);
  }

  /** Waits for the start's answer, at most `startTimeoutMs` after it was sent. */
  private async untilAnswered(entry: LeaseEntry<Session, Handle, Request>): Promise<void> {
    if (entry.answered) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, entry.answerBy - Date.now()));
    });
    try {
      await Promise.race([entry.answer, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Joins this rental's stop in flight, or sends it, within `stopTimeoutMs`. */
  private async stop(rental: RentalRecord<Handle>): Promise<StopFailure | undefined> {
    rental.stopping ??= this.stopHandle(rental.handle).then((failure) => {
      if (failure === undefined) rental.stopped = true;
      rental.stopping = undefined;
      return failure;
    });
    const stopping = rental.stopping;
    const limitMs = this.driver.stopTimeoutMs;
    if (limitMs === undefined) return await stopping;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<StopFailure>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({ cause: new Error(`The provider stop did not answer within ${limitMs} ms.`) }),
        limitMs,
      );
    });
    try {
      return await Promise.race([stopping, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async stopHandle(handle: Handle): Promise<StopFailure | undefined> {
    try {
      await this.driver.stop(handle);
      return undefined;
    } catch (error) {
      return { cause: error };
    }
  }

  private pending(
    entry: LeaseEntry<Session, Handle, Request>,
    ended: Extract<Ended<Session, Handle>, { status: 'pending' }>,
    scope: ProviderLeaseCleanupScope,
  ): Error {
    return this.driver.cleanupPending(
      ended.owed.map((owed) => ({ leaseId: entry.lease.leaseId, ...owed })),
      scope,
    );
  }
}

/** Records what the start's answer says it rented, and wakes any teardown waiting on it. */
function recordAnswer<Session, Handle, Request>(
  entry: LeaseEntry<Session, Handle, Request>,
  answer: StartAnswer<Session, Handle>,
  handleKey: (handle: Handle) => string,
): void {
  switch (answer.status) {
    case 'ready':
      holdRental(entry, answer.handle, handleKey(answer.handle));
      break;
    case 'failed':
      if (answer.rented !== undefined) holdRental(entry, answer.rented, handleKey(answer.rented));
      break;
    case 'rejected':
      if (entry.rentals.size === 0) entry.unnamed = true;
      break;
  }
  entry.answered = true;
  entry.markAnswered();
}

/** Adds a rental the entry owes a stop, unless the same rental is already known. */
function holdRental<Session, Handle, Request>(
  entry: LeaseEntry<Session, Handle, Request>,
  handle: Handle,
  key: string,
): void {
  if (!entry.rentals.has(key))
    entry.rentals.set(key, { handle, stopped: false, stopping: undefined });
  entry.latest = handle;
}

/** The budget a caller named, without the fields it left unset. */
function callerBudget(options: ProviderLeaseBudget): ProviderLeaseBudget {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  };
}

/** Whether a caller hung up or ran past its deadline. */
function budgetSpent(caller: ProviderLeaseBudget, deadline: number): boolean {
  return caller.signal?.aborted === true || Date.now() >= deadline;
}

/** Whether any caller still waits for the start within its own budget. */
function stillWanted<Session, Handle, Request>(
  entry: LeaseEntry<Session, Handle, Request>,
): boolean {
  const now = Date.now();
  for (const waiter of entry.waiters) {
    if (!waiter.signal?.aborted && now < waiter.deadline) return true;
  }
  return false;
}
