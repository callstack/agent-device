import type { DeviceLease } from '@agent-device/contracts/device';

/**
 * The lease table one cloud device provider runtime serves its lease lifecycle from.
 *
 * A provider rents a billed device per lease. The bookkeeping around that rental is the same for every
 * provider, and each rule is one a provider gets wrong on its own: a second allocation of one lease rents a
 * second device nobody can release; a session forgotten before its stop is confirmed stays billed; a drain
 * that skips a start still in flight misses the device that start rents; and a caller that stopped waiting
 * leaves a device whose only handle is the answer still to come. This table owns those rules. The provider
 * supplies start, stop, find-by-lease, and the errors it reports in its own words.
 *
 * Keep this module free of value imports: provider runtimes load it on their construction path.
 */

/** One caller's patience: the signal it cancels with, and the epoch-ms instant it stops waiting. */
export type ProviderLeaseBudget = Readonly<{ signal?: AbortSignal; deadline?: number }>;

/** A budget the table has bounded by the provider's own start timeout, so it always has a deadline. */
export type ProviderLeaseBoundedBudget = Readonly<{ signal?: AbortSignal; deadline: number }>;

/**
 * What one start amounted to. A ready start hands over its session and the handle that stops it. A failed
 * start names in `rented` what it left under rent, or omits it when the provider refused the start
 * outright. A start reports what it rented and never stops it itself: the table holds the only handle.
 */
export type ProviderLeaseStart<Session, Handle> =
  | Readonly<{ status: 'ready'; session: Session; handle: Handle }>
  | Readonly<{ status: 'failed'; error: unknown; rented?: Handle }>;

/** Which route found a stop unconfirmed, so the provider reports it with the matching details. */
export type ProviderLeaseCleanupScope =
  | Readonly<{ route: 'start' | 'release' | 'recover'; leaseId: string }>
  | Readonly<{ route: 'shutdown' }>;

/** A rented session whose stop the provider did not confirm, and the stop's own failure. */
export type ProviderUnconfirmedStop<Handle> = Readonly<{ handle: Handle; cause: unknown }>;

export type ProviderLeaseDriver<Session, Handle, Request> = Readonly<{
  /** The longest one allocation may take. The caller's deadline wins when it is earlier. */
  startTimeoutMs: number;
  /**
   * Rents the lease's device within `budget`. A rejection is read as a start that may have rented, and
   * the table stops what {@link findByLease} names for the lease.
   */
  start(
    lease: DeviceLease,
    request: Request,
    budget: ProviderLeaseBoundedBudget,
  ): Promise<ProviderLeaseStart<Session, Handle>>;
  /** Stops one rented session. Resolves only once the provider confirmed the device is no longer rented. */
  stop(handle: Handle): Promise<void>;
  /**
   * Names what a lease rented when this process holds no entry for it, as after a daemon restart.
   * Rejects when the provider cannot name it, so the daemon keeps the lease pending.
   */
  findByLease(lease: DeviceLease): Promise<Handle>;
  /** The error for an allocation that arrives or finishes while the runtime shuts down. */
  shuttingDown(lease: DeviceLease): Error;
  /**
   * The error for a caller that stopped waiting: its signal aborted, or its `budget.deadline` passed.
   * `budgetMs` is the wait it was granted, and `rented` the session it leaves behind when one is known.
   */
  gaveUp(
    lease: DeviceLease,
    budget: ProviderLeaseBoundedBudget,
    budgetMs: number,
    rented: Handle | undefined,
  ): Error;
  /** The error for sessions that stay rented because their stop was not confirmed. */
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
  /** The ready session a lease holds in this process. */
  live(leaseId: string): Session | undefined;
  /**
   * The request the lease's entry was started for, so a provider can refuse a joining allocation that
   * asks for something else. Call it right before `allocate`, with no await between them.
   */
  requestOf(leaseId: string): Request | undefined;
  /**
   * Rents one device per lease id. A lease that is already starting is joined, and one that is ready is
   * reused. Each caller waits within its own budget; a caller that gives up leaves the start running.
   */
  allocate(lease: DeviceLease, request: Request, budget?: ProviderLeaseBudget): Promise<Session>;
  /**
   * Stops the lease's session and forgets it once the stop is confirmed. Resolves `undefined` when this
   * process holds nothing for the lease. Rejects, keeping the session for a retry, when the stop fails.
   */
  release(leaseId: string): Promise<ProviderLeaseReleased<Session, Handle> | undefined>;
  /** Ends an expired lease, from its entry when this process has one and from `findByLease` otherwise. */
  recover(lease: DeviceLease): Promise<void>;
  /** Refuses new allocations, waits for every start, and stops every session. Rejects with what stays rented. */
  shutdown(): Promise<void>;
}>;

type Outcome<Session> =
  | Readonly<{ status: 'ready'; session: Session }>
  | Readonly<{ status: 'failed'; error: unknown }>;

type StopFailure = Readonly<{ cause: unknown }>;

type Ended<Session, Handle> = ProviderLeaseReleased<Session, Handle> &
  Readonly<{ failure: StopFailure | undefined }>;

/**
 * One lease's place in the table, from the moment its start is sent until the provider confirms the stop
 * of what that start rented.
 */
class LeaseEntry<Session, Handle, Request> {
  readonly request: Request;
  /** Settles once the start answered and the stop a failed start owed has settled with it. */
  readonly start: Promise<Outcome<Session>>;
  session: Session | undefined = undefined;
  /** What this entry has to stop; absent while the start has not answered, or when it rented nothing. */
  owed: Handle | undefined = undefined;
  stopConfirmed = false;
  /** The one stop in flight, joined by every concurrent caller and cleared once it settles. */
  stopping: Promise<StopFailure | undefined> | undefined = undefined;

  /** `start` may write this entry's fields but must not await them: `this.start` is unset while it runs. */
  constructor(
    request: Request,
    start: (entry: LeaseEntry<Session, Handle, Request>) => Promise<Outcome<Session>>,
  ) {
    this.request = request;
    this.start = start(this);
  }
}

export function createProviderLeaseTable<Session, Handle, Request>(
  driver: ProviderLeaseDriver<Session, Handle, Request>,
): ProviderLeaseTable<Session, Handle, Request> {
  const table = new LeaseTable(driver);
  return Object.freeze({
    live: (leaseId: string) => table.entries.get(leaseId)?.session,
    requestOf: (leaseId: string) => table.entries.get(leaseId)?.request,
    allocate: async (lease: DeviceLease, request: Request, budget?: ProviderLeaseBudget) =>
      await table.allocate(lease, request, budget),
    release: async (leaseId: string) => await table.release(leaseId),
    recover: async (lease: DeviceLease) => await table.recover(lease),
    shutdown: async () => await table.shutdown(),
  });
}

class LeaseTable<Session, Handle, Request> {
  /** An entry leaves only once its stop is confirmed, or when its start rented nothing. */
  readonly entries = new Map<string, LeaseEntry<Session, Handle, Request>>();
  private shuttingDown = false;
  private readonly driver: ProviderLeaseDriver<Session, Handle, Request>;

  constructor(driver: ProviderLeaseDriver<Session, Handle, Request>) {
    this.driver = driver;
  }

  async allocate(
    lease: DeviceLease,
    request: Request,
    budget: ProviderLeaseBudget = {},
  ): Promise<Session> {
    // Nothing between this check and the entry's registration awaits, so shutdown cannot miss a start.
    if (this.shuttingDown) throw this.driver.shuttingDown(lease);
    const bounded = this.bound(budget);
    const entry = this.entries.get(lease.leaseId) ?? this.rent(lease, request, bounded);
    const outcome = await this.join(lease, entry, bounded);
    // Shutdown already owns the entry, so a runtime that is going away hands out no session.
    if (this.shuttingDown) throw this.driver.shuttingDown(lease);
    if (outcome.status === 'failed') throw outcome.error;
    return outcome.session;
  }

  async release(leaseId: string): Promise<ProviderLeaseReleased<Session, Handle> | undefined> {
    const entry = this.entries.get(leaseId);
    if (!entry) return undefined;
    const ended = await this.end(leaseId, entry);
    if (ended === undefined) return undefined;
    if (ended.failure !== undefined) {
      throw this.pending(ended.handle, ended.failure, { route: 'release', leaseId });
    }
    return { handle: ended.handle, session: ended.session };
  }

  async recover(lease: DeviceLease): Promise<void> {
    const leaseId = lease.leaseId;
    const entry = this.entries.get(leaseId);
    if (entry) {
      const ended = await this.end(leaseId, entry);
      if (ended?.failure !== undefined) {
        throw this.pending(ended.handle, ended.failure, { route: 'recover', leaseId });
      }
      return;
    }
    // The daemon forgets a recovered lease once this resolves, so an unconfirmed stop has to reject.
    const handle = await this.driver.findByLease(lease);
    const failure = await this.stopHandle(handle);
    if (failure !== undefined) throw this.pending(handle, failure, { route: 'recover', leaseId });
  }

  /**
   * Awaits every entry, including starts whose callers gave up, because each of them may still name a
   * device. A failed stop keeps its entry, so a later release retries the same session.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const ended = await Promise.all(
      [...this.entries].map(async ([leaseId, entry]) => await this.end(leaseId, entry)),
    );
    const unconfirmed = ended.flatMap((outcome) =>
      outcome?.failure === undefined
        ? []
        : [{ handle: outcome.handle, cause: outcome.failure.cause }],
    );
    if (unconfirmed.length > 0) {
      throw this.driver.cleanupPending(unconfirmed, { route: 'shutdown' });
    }
  }

  /** The caller's budget, cut to the provider's own start timeout. */
  private bound(budget: ProviderLeaseBudget): ProviderLeaseBoundedBudget {
    const timeoutAt = Date.now() + this.driver.startTimeoutMs;
    return {
      ...(budget.signal === undefined ? {} : { signal: budget.signal }),
      deadline: budget.deadline === undefined ? timeoutAt : Math.min(budget.deadline, timeoutAt),
    };
  }

  /** Registers the entry before the first await, so a concurrent allocation or release finds it. */
  private rent(
    lease: DeviceLease,
    request: Request,
    budget: ProviderLeaseBoundedBudget,
  ): LeaseEntry<Session, Handle, Request> {
    const entry = new LeaseEntry<Session, Handle, Request>(request, (target) =>
      this.runStart(target, lease, budget),
    );
    this.entries.set(lease.leaseId, entry);
    return entry;
  }

  /**
   * Runs the start and stops what a start that did not become ready rented, before its failure reaches
   * any caller. A ready answer after the starting caller's budget passed is not handed out either.
   */
  private async runStart(
    entry: LeaseEntry<Session, Handle, Request>,
    lease: DeviceLease,
    budget: ProviderLeaseBoundedBudget,
  ): Promise<Outcome<Session>> {
    const startedAt = Date.now();
    let started: ProviderLeaseStart<Session, Handle>;
    try {
      started = await this.driver.start(lease, entry.request, budget);
    } catch (error) {
      started = await this.unansweredStart(lease, error);
    }
    if (started.status === 'ready') {
      if (!budget.signal?.aborted && Date.now() < budget.deadline) {
        entry.session = started.session;
        entry.owed = started.handle;
        return { status: 'ready', session: started.session };
      }
      started = {
        status: 'failed',
        rented: started.handle,
        error: this.driver.gaveUp(
          lease,
          budget,
          Math.max(0, budget.deadline - startedAt),
          started.handle,
        ),
      };
    }
    const rented = started.rented;
    if (rented === undefined) {
      entry.stopConfirmed = true;
      this.close(lease.leaseId, entry);
      return { status: 'failed', error: started.error };
    }
    entry.owed = rented;
    const failure = await this.stopOwed(entry, rented);
    if (failure === undefined) {
      entry.stopConfirmed = true;
      this.close(lease.leaseId, entry);
      return { status: 'failed', error: started.error };
    }
    // What is still billed outranks why the start failed, so the report names the session to end.
    return {
      status: 'failed',
      error: this.driver.cleanupPending(
        [{ handle: rented, cause: failure.cause }],
        { route: 'start', leaseId: lease.leaseId },
        started.error,
      ),
    };
  }

  /**
   * A start that rejected may have rented, so the lease's own handle is what this entry owes. A provider
   * that cannot name it leaves the table nothing to stop, and the caller hears the start's failure.
   */
  private async unansweredStart(
    lease: DeviceLease,
    error: unknown,
  ): Promise<ProviderLeaseStart<Session, Handle>> {
    try {
      return { status: 'failed', error, rented: await this.driver.findByLease(lease) };
    } catch {
      return { status: 'failed', error };
    }
  }

  /**
   * Waits for the entry's start within this caller's budget. A caller that gives up stops nothing: the
   * device belongs to every caller still waiting, and the entry stops what the start rents.
   */
  private async join(
    lease: DeviceLease,
    entry: LeaseEntry<Session, Handle, Request>,
    budget: ProviderLeaseBoundedBudget,
  ): Promise<Outcome<Session>> {
    if (entry.session !== undefined) return { status: 'ready', session: entry.session };
    const joinedAt = Date.now();
    const signal = budget.signal
      ? AbortSignal.any([
          budget.signal,
          AbortSignal.timeout(Math.max(0, budget.deadline - joinedAt)),
        ])
      : AbortSignal.timeout(Math.max(0, budget.deadline - joinedAt));
    const giveUp = () =>
      this.driver.gaveUp(lease, budget, Math.max(0, budget.deadline - joinedAt), entry.owed);
    if (signal.aborted) throw giveUp();
    let onAbort = (): void => undefined;
    const gaveUp = new Promise<never>((_, reject) => {
      onAbort = () => reject(giveUp());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([entry.start, gaveUp]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Waits for the entry's start, stops what it owes, and closes it once the stop is confirmed. Every route
   * that ends a device comes through here, so an unconfirmed stop stays for the next caller to retry.
   */
  private async end(
    leaseId: string,
    entry: LeaseEntry<Session, Handle, Request>,
  ): Promise<Ended<Session, Handle> | undefined> {
    await entry.start;
    const handle = entry.owed;
    if (handle === undefined) return undefined;
    const failure = entry.stopConfirmed ? undefined : await this.stopOwed(entry, handle);
    if (failure === undefined) {
      entry.stopConfirmed = true;
      this.close(leaseId, entry);
    }
    return { handle, session: entry.session, failure };
  }

  private close(leaseId: string, entry: LeaseEntry<Session, Handle, Request>): void {
    if (this.entries.get(leaseId) === entry) this.entries.delete(leaseId);
  }

  private stopOwed(
    entry: LeaseEntry<Session, Handle, Request>,
    handle: Handle,
  ): Promise<StopFailure | undefined> {
    entry.stopping ??= this.stopHandle(handle).finally(() => {
      entry.stopping = undefined;
    });
    return entry.stopping;
  }

  private async stopHandle(handle: Handle): Promise<StopFailure | undefined> {
    try {
      await this.driver.stop(handle);
      return undefined;
    } catch (error) {
      return { cause: error };
    }
  }

  private pending(handle: Handle, failure: StopFailure, scope: ProviderLeaseCleanupScope): Error {
    return this.driver.cleanupPending([{ handle, cause: failure.cause }], scope);
  }
}
