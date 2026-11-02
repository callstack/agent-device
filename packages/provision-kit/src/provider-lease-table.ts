import type { DeviceLease } from '@agent-device/contracts/device';

/**
 * The lease table one cloud device provider runtime serves its lease lifecycle from.
 *
 * A provider rents a billed device per lease. The bookkeeping around that rental is the same for every
 * provider, and each rule is one a provider gets wrong on its own: a second allocation of one lease rents a
 * second device nobody can release; a session forgotten before its stop is confirmed stays billed; a drain
 * that skips a start still in flight misses the device that start rents; an allocation that wins a race
 * with a release is handed a device that is being stopped; and a caller that stopped waiting leaves a
 * device whose only handle is the answer still to come. This table owns those rules. The provider supplies
 * start, stop, find-by-lease, and the errors it reports in its own words.
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
   * The budget of the caller that registered the start, as it asked. Its deadline bounds the provider's
   * own work. Its signal belongs to that caller alone: the start runs for every caller that joins it, so
   * a provider that ends the start on that signal takes the device from callers still waiting.
   */
  caller: ProviderLeaseBudget;
  /** Epoch-ms by which the start should answer: the caller's deadline, cut to `startTimeoutMs`. */
  deadline: number;
  /**
   * Publishes a rental as soon as the provider can stop it, before the start answers, so a release or a
   * drain can stop a device whose start stalls. A later call replaces the handle. Do not publish a handle
   * whose stop could arrive before the provider created the session it names.
   */
  rented(handle: Handle): void;
}>;

/**
 * What one start amounted to. A ready start hands over its session and the handle that stops it. A failed
 * start names in `rented` what it left under rent; omitting it says the provider rented nothing, which
 * also discards a handle published through `rented`. A start that rejects instead is read as one that may
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

/** What this process knows a lease rented. `unknown` means it may have rented and must be found. */
type Rental<Handle> =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'held'; handle: Handle }>
  | Readonly<{ kind: 'unknown' }>;

type StopFailure = Readonly<{ cause: unknown }>;

/** One caller waiting for a start, with the budget that decides whether it still wants the device. */
type Waiter = Readonly<{ deadline: number; signal: AbortSignal | undefined }>;

type StartAnswer<Session, Handle> =
  | ProviderLeaseStart<Session, Handle>
  | Readonly<{ status: 'rejected'; error: unknown }>;

type Ended<Session, Handle> =
  | Readonly<{ status: 'stopped'; handle: Handle; session: Session | undefined }>
  | Readonly<{ status: 'nothing-rented' }>
  | Readonly<{ status: 'pending'; handle: Handle | undefined; cause: unknown }>;

/**
 * One lease's place in the table, from the moment its start is sent, or its recovery begins, until every
 * rental it knows of is confirmed stopped.
 */
class LeaseEntry<Session, Handle, Request> {
  readonly lease: DeviceLease;
  /** What the start was asked for; absent for an entry a recovery opened. */
  readonly request: Request | undefined;
  /** The deadline handed to the start: the starting caller's deadline, cut to `startTimeoutMs`. */
  readonly deadline: number;
  /** When a teardown stops waiting for the start to answer: `startTimeoutMs` after it was sent. */
  readonly answerBy: number;
  /** Settles once the start answered and, for a start that failed, once its teardown settled. */
  start: Promise<Outcome<Session>> = Promise.resolve({ status: 'failed', error: undefined });
  answered = false;
  readonly answer: Promise<void>;
  markAnswered: () => void = () => undefined;
  session: Session | undefined = undefined;
  rental: Rental<Handle> = { kind: 'none' };
  /** The rental whose stop the provider confirmed, by `handleKey`. */
  stopped: string | undefined = undefined;
  /** The stop in flight, which outlives a teardown that stopped waiting for it. */
  stopping: Readonly<{ key: string; promise: Promise<StopFailure | undefined> }> | undefined =
    undefined;
  /** Callers still waiting for the start; one leaves the moment it gives up. */
  readonly waiters = new Set<Waiter>();
  /** Set once anything starts ending the lease; it never serves an allocation again. */
  releasing = false;
  /** The one teardown in flight, joined by every release, recovery, and drain. */
  ending: Promise<Ended<Session, Handle>> | undefined = undefined;

  constructor(
    lease: DeviceLease,
    request: Request | undefined,
    deadline: number,
    answerBy: number,
  ) {
    this.lease = lease;
    this.request = request;
    this.deadline = deadline;
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
  private readonly driver: ProviderLeaseDriver<Session, Handle, Request>;

  constructor(driver: ProviderLeaseDriver<Session, Handle, Request>) {
    this.driver = driver;
  }

  live(leaseId: string): Session | undefined {
    const entry = this.entries.get(leaseId);
    return entry?.releasing ? undefined : entry?.session;
  }

  async allocate(
    lease: DeviceLease,
    request: Request,
    options: ProviderLeaseAllocateOptions<Request> = {},
  ): Promise<Session> {
    // Nothing between these checks and the entry's registration awaits, so no teardown is missed.
    if (this.shuttingDown) throw this.driver.shuttingDown(lease);
    const existing = this.entries.get(lease.leaseId);
    if (existing?.releasing) throw this.driver.releasing(lease);
    if (existing?.request !== undefined) options.requireJoinable?.(existing.request);
    const caller: ProviderLeaseBudget = {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    };
    const timeoutAt = Date.now() + this.driver.startTimeoutMs;
    const deadline = Math.min(caller.deadline ?? timeoutAt, timeoutAt);
    // A caller whose budget is already spent never sends a start that nobody would wait for.
    if (!existing && (caller.signal?.aborted || deadline <= Date.now())) {
      throw this.driver.gaveUp(lease, caller, 0, undefined);
    }
    const entry = existing ?? this.rent(lease, request, caller, deadline, timeoutAt);
    const outcome = await this.join(entry, caller, deadline);
    if (this.shuttingDown) throw this.driver.shuttingDown(lease);
    if (outcome.status === 'failed') throw outcome.error;
    // A release that started while this caller waited owns the device now.
    if (entry.releasing) throw this.driver.releasing(lease);
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
    const entry = this.entries.get(leaseId) ?? this.recovering(lease);
    const ended = await this.teardown(entry);
    if (ended.status === 'pending') throw this.pending(entry, ended, { route: 'recover', leaseId });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const unconfirmed: ProviderUnconfirmedStop<Handle>[] = [];
    const drained = new Set<LeaseEntry<Session, Handle, Request>>();
    // A recovery or release can open an entry while the drain runs, so the drain repeats until it has
    // ended every entry it finds.
    for (;;) {
      const entries = [...this.entries.values()].filter((entry) => !drained.has(entry));
      if (entries.length === 0) break;
      for (const entry of entries) drained.add(entry);
      const ended = await Promise.all(entries.map(async (entry) => await this.teardown(entry)));
      ended.forEach((outcome, index) => {
        if (outcome.status !== 'pending') return;
        const leaseId = entries[index]!.lease.leaseId;
        unconfirmed.push({ leaseId, handle: outcome.handle, cause: outcome.cause });
      });
    }
    if (unconfirmed.length > 0) {
      throw this.driver.cleanupPending(unconfirmed, { route: 'shutdown' });
    }
  }

  /** Registers the entry before the first await, so a concurrent allocation or release finds it. */
  private rent(
    lease: DeviceLease,
    request: Request,
    caller: ProviderLeaseBudget,
    deadline: number,
    answerBy: number,
  ): LeaseEntry<Session, Handle, Request> {
    const entry = new LeaseEntry<Session, Handle, Request>(lease, request, deadline, answerBy);
    entry.start = this.runStart(entry, request, caller);
    this.entries.set(lease.leaseId, entry);
    return entry;
  }

  /** Registers an entry for a lease this process holds nothing for, so every route joins its teardown. */
  private recovering(lease: DeviceLease): LeaseEntry<Session, Handle, Request> {
    const entry = new LeaseEntry<Session, Handle, Request>(
      lease,
      undefined,
      Date.now(),
      Date.now(),
    );
    entry.answered = true;
    entry.markAnswered();
    entry.rental = { kind: 'unknown' };
    entry.releasing = true;
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
    const answer = await this.callStart(entry, request, caller);
    recordAnswer(entry, answer);
    if (answer.status === 'ready') {
      // Recorded even when nobody takes it, so the teardown reports the device it stopped.
      entry.session = answer.session;
      if (!entry.releasing && stillWanted(entry))
        return { status: 'ready', session: answer.session };
    }
    return await this.endFailedStart(entry, this.startFailure(entry, answer, caller, startedAt));
  }

  /** The start's answer, with a rejection read as an answer that may have rented. */
  private async callStart(
    entry: LeaseEntry<Session, Handle, Request>,
    request: Request,
    caller: ProviderLeaseBudget,
  ): Promise<StartAnswer<Session, Handle>> {
    try {
      return await this.driver.start(entry.lease, request, {
        caller,
        deadline: entry.deadline,
        rented: (handle) => {
          if (!entry.answered) entry.rental = { kind: 'held', handle };
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
    if (entry.releasing) return this.driver.releasing(entry.lease);
    const budgetMs = Math.max(0, entry.deadline - startedAt);
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
    if (entry.releasing) {
      void this.teardown(entry).catch(() => undefined);
      return { status: 'failed', error };
    }
    const ended = await this.teardown(entry);
    if (ended.status !== 'pending') return { status: 'failed', error };
    // What is still billed outranks why the start failed, so the report names the rental to end.
    const leaseId = entry.lease.leaseId;
    return {
      status: 'failed',
      error: this.driver.cleanupPending(
        [{ leaseId, handle: ended.handle, cause: ended.cause }],
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
    if (entry.session !== undefined) return { status: 'ready', session: entry.session };
    const budgetMs = Math.max(0, deadline - Date.now());
    const giveUp = () =>
      this.driver.gaveUp(
        entry.lease,
        caller,
        budgetMs,
        entry.rental.kind === 'held' ? entry.rental.handle : undefined,
      );
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), budgetMs);
    const signal = caller.signal
      ? AbortSignal.any([caller.signal, timeout.signal])
      : timeout.signal;
    const waiter: Waiter = { deadline, signal: caller.signal };
    let onAbort = (): void => undefined;
    try {
      entry.waiters.add(waiter);
      if (signal.aborted) throw giveUp();
      const gaveUp = new Promise<never>((_, reject) => {
        onAbort = () => reject(giveUp());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([entry.start, gaveUp]);
    } finally {
      entry.waiters.delete(waiter);
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The one teardown of an entry, joined by every route that ends it. It fences the entry against
   * allocations in the same step, and it is the only place a rental is stopped or an entry forgotten.
   */
  private teardown(entry: LeaseEntry<Session, Handle, Request>): Promise<Ended<Session, Handle>> {
    entry.releasing = true;
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
    for (;;) {
      await this.untilAnswered(entry);
      const unnamed = await this.nameRental(entry);
      if (unnamed !== undefined) return unnamed;
      const handle = entry.rental.kind === 'held' ? entry.rental.handle : undefined;
      if (handle === undefined || entry.stopped === this.driver.handleKey(handle)) {
        return this.finishTeardown(entry, handle);
      }
      const failure = await this.stop(entry, handle);
      if (failure !== undefined) return { status: 'pending', handle, cause: failure.cause };
      // The start may have answered, or named another rental, while the stop ran.
    }
  }

  /** Asks the provider for a rental this process may hold but cannot name. */
  private async nameRental(
    entry: LeaseEntry<Session, Handle, Request>,
  ): Promise<Ended<Session, Handle> | undefined> {
    if (entry.rental.kind !== 'unknown') return undefined;
    try {
      const handle = await this.driver.findByLease(entry.lease);
      if (entry.rental.kind === 'unknown') entry.rental = { kind: 'held', handle };
      return undefined;
    } catch (error) {
      return { status: 'pending', handle: undefined, cause: error };
    }
  }

  /** Forgets an entry whose rentals are all stopped, unless its start may still rent something. */
  private finishTeardown(
    entry: LeaseEntry<Session, Handle, Request>,
    handle: Handle | undefined,
  ): Ended<Session, Handle> {
    if (!entry.answered) {
      // The entry stays for the teardown that the start's answer starts.
      return {
        status: 'pending',
        handle,
        cause: new Error('The provider start did not answer within its start timeout.'),
      };
    }
    if (this.entries.get(entry.lease.leaseId) === entry) this.entries.delete(entry.lease.leaseId);
    return handle === undefined
      ? { status: 'nothing-rented' }
      : { status: 'stopped', handle, session: entry.session };
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

  /** Joins the stop in flight for this handle, or sends it, within `stopTimeoutMs`. */
  private async stop(
    entry: LeaseEntry<Session, Handle, Request>,
    handle: Handle,
  ): Promise<StopFailure | undefined> {
    const key = this.driver.handleKey(handle);
    let stopping = entry.stopping;
    if (stopping?.key !== key) {
      const promise = this.stopHandle(handle).then((failure) => {
        if (failure === undefined) entry.stopped = key;
        if (entry.stopping?.promise === promise) entry.stopping = undefined;
        return failure;
      });
      stopping = { key, promise };
      entry.stopping = stopping;
    }
    const limitMs = this.driver.stopTimeoutMs;
    if (limitMs === undefined) return await stopping.promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<StopFailure>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({ cause: new Error(`The provider stop did not answer within ${limitMs} ms.`) }),
        limitMs,
      );
    });
    try {
      return await Promise.race([stopping.promise, expired]);
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
      [{ leaseId: entry.lease.leaseId, handle: ended.handle, cause: ended.cause }],
      scope,
    );
  }
}

/** Records what the start's answer says it rented, and wakes any teardown waiting on it. */
function recordAnswer<Session, Handle, Request>(
  entry: LeaseEntry<Session, Handle, Request>,
  answer: StartAnswer<Session, Handle>,
): void {
  switch (answer.status) {
    case 'ready':
      entry.rental = { kind: 'held', handle: answer.handle };
      break;
    case 'failed':
      entry.rental =
        answer.rented === undefined ? { kind: 'none' } : { kind: 'held', handle: answer.rented };
      break;
    case 'rejected':
      if (entry.rental.kind !== 'held') entry.rental = { kind: 'unknown' };
      break;
  }
  entry.answered = true;
  entry.markAnswered();
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
