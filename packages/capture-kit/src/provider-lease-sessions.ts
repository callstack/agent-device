/**
 * The lease-session table one remote device-cloud provider runtime serves from.
 *
 * A provider runtime answers the daemon's allocate, release, and expiry-recovery calls with a
 * device it rented from its own cloud. The bookkeeping around those calls is what one provider
 * tends to re-derive and get differently from the next: a second allocation of one lease id rents a
 * second device nobody can release; a session forgotten before its stop is confirmed strands the
 * device that paid for it; a drain that forgets a session whose stop failed reports a clean
 * shutdown while the device stays up; and an allocation the caller stopped waiting for leaves a
 * rented device with no handle anywhere. This table owns all of it. The provider owns the
 * transport, and says how to start, stop, and find a session.
 *
 * A provider runtime creates the table with its driver and forwards its lease lifecycle to
 * `allocate` and `release`. `release` answers the release call and the expiry-recovery call, so a
 * lease the daemon is retrying stays retryable here too. A caller may not own the lease's account,
 * so nothing here reads the caller's identity: the driver decides what this process may stop.
 *
 * Keep this module free of value imports and keep it small. A provider runtime is reached from its
 * package entry, which the daemon evaluates at boot, so an edge added here is paid on every boot.
 */

/** Why an allocation, release, or drain did not complete. The driver raises it as the error it reports. */
export type ProviderLeaseRejection =
  | Readonly<{ reason: 'provider-runtime-shutting-down' }>
  | Readonly<{ reason: 'provider-allocation-cancelled'; leaseId: string }>
  | Readonly<{
      reason: 'provider-start-deadline-exceeded';
      leaseId: string;
      deadlineAt: number;
    }>
  /**
   * A stop did not confirm, for the session a release named or for every session a drain reached.
   * The session stays recorded, so the caller may retry.
   */
  | Readonly<{ reason: 'provider-stop-unconfirmed'; leaseId: string; cause: unknown }>
  | Readonly<{ reason: 'provider-drain-unconfirmed'; leaseIds: readonly string[] }>
  /** The provider could not say whether a session exists for a lease id, usually because its search failed. */
  | Readonly<{ reason: 'provider-lease-search-unanswered'; leaseId: string; cause: unknown }>
  /** The provider found a session it cannot stop, so the device stays rented. */
  | Readonly<{ reason: 'provider-lease-not-releasable'; leaseId: string }>;

/**
 * What a rejection amounts to, in the vocabulary every provider shares. A provider puts it in the
 * error details, so a caller can branch without matching message text.
 */
export type ProviderLeaseFailureReason =
  | 'provider-runtime-shutting-down'
  | 'provider-allocation-cancelled'
  | 'provider-start-deadline-exceeded'
  /** Something may still be renting a device: a stop, a search, or a drain that did not answer. */
  | 'provider-cleanup-pending';

/** The reason a rejection reports: only the cases a caller ends are their own; the rest are pending. */
export function providerLeaseFailureReason(
  rejection: ProviderLeaseRejection,
): ProviderLeaseFailureReason {
  switch (rejection.reason) {
    case 'provider-runtime-shutting-down':
    case 'provider-allocation-cancelled':
    case 'provider-start-deadline-exceeded':
      return rejection.reason;
    case 'provider-stop-unconfirmed':
    case 'provider-drain-unconfirmed':
    case 'provider-lease-search-unanswered':
    case 'provider-lease-not-releasable':
      return 'provider-cleanup-pending';
  }
}

/**
 * What the provider's search for the sessions serving one lease id answered. A provider reports
 * `unknown` for a search that could not answer, never `absent`: the daemon ends a lease the table
 * releases, and `absent` would end one whose device is still rented.
 */
export type ProviderLeaseSearch<Lease> =
  | Readonly<{ status: 'found'; lease: Lease }>
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unknown'; cause: unknown }>;

/**
 * What ending sessions this process did not start amounted to. `artifacts` is what the daemon must
 * persist for them, and `undefined` from the driver means this provider cannot stop such sessions.
 */
export type ProviderLeaseStopOutcome =
  | Readonly<{ stopped: true; artifacts?: Record<string, unknown> }>
  | Readonly<{ stopped: false; cause: unknown }>;

/** The limit one allocation respects. `deadlineAt` is `Date.now()`-comparable. */
export type ProviderLeaseOptions = Readonly<{ signal?: AbortSignal; deadlineAt?: number }>;

/**
 * What `start` may do while it rents a device. `adopt` records the session so a release or a drain
 * can find it; call it as soon as the device is rented. From that point the session stays recorded,
 * including when a later phase of starting fails: only this process holds the handle to it.
 */
export type ProviderLeaseStartControl<Session> = Readonly<{
  /** The caller's cancellation, or `undefined` when the request carries none. */
  signal: AbortSignal | undefined;
  /** Epoch-ms by which the caller stops waiting, or `undefined` when the request carries no deadline. */
  deadlineAt: number | undefined;
  adopt(session: Session): void;
}>;

/**
 * The provider's half of the table. `Session` is whatever the provider needs to keep serving a
 * session it started, and `Request` is the allocation or release call it receives; the table only
 * carries them between its methods and the callbacks that take one.
 */
export type ProviderLeaseSessionDriver<Session, Lease, Request> = Readonly<{
  /**
   * Checks a request before the table reuses a session or rents a device, so a request the provider
   * refuses never joins an allocation in flight. Raise to refuse it.
   */
  prepare?(request: Request, options: ProviderLeaseOptions): Promise<void> | void;
  /**
   * Rents the device and starts serving it, and resolves with what the caller receives in the shape
   * `LeaseLifecycleProvider.allocate` reports. `signal` and `deadlineAt` are the caller's, so a
   * provider that can abandon a rental mid-flight does so here; the table also stops a device this
   * process adopted after either one passed.
   */
  start(
    request: Request,
    control: ProviderLeaseStartControl<Session>,
  ): Promise<Record<string, unknown> | undefined>;
  /** What a caller may reuse from the session this runtime already serves for its lease id. */
  reuse(session: Session, request: Request): Promise<Record<string, unknown> | undefined>;
  /**
   * What the daemon must persist when this session ends, or `undefined` for nothing. The table reads
   * it before the stop, so a release that has to retry reports the same device it did the first time.
   */
  describeRelease(session: Session): Promise<Record<string, unknown> | undefined>;
  /** Stops a session this process started. Raises when the stop did not confirm. */
  stop(session: Session): Promise<void>;
  /** Finds the sessions serving the lease a request names, which another process may have started. */
  searchLease(request: Request): Promise<ProviderLeaseSearch<Lease>>;
  /** Ends sessions this process did not start. */
  stopLease(lease: Lease): Promise<ProviderLeaseStopOutcome | undefined>;
  /**
   * Builds the error that reports a rejection. `reason` is what the rejection amounts to in the
   * shared vocabulary, so a provider reports it without re-deriving the mapping.
   */
  reject(rejection: ProviderLeaseRejection, reason: ProviderLeaseFailureReason): Error;
}>;

/** The lease-session table a provider runtime forwards its lease lifecycle to. */
export type ProviderLeaseSessionTable<Session, Request> = Readonly<{
  /** The session this runtime holds for a lease id, whether or not it is releasing. */
  find(leaseId: string): Session | undefined;
  /** Rents one device for one lease id, or reuses the session that already serves it. */
  allocate(
    request: Request,
    leaseId: string,
    options?: ProviderLeaseOptions,
  ): Promise<Record<string, unknown> | undefined>;
  /**
   * Stops the session for a lease id and forgets it only once the stop confirmed; resolves with what
   * the daemon must persist. With no session of its own, it ends what the driver's `searchLease`
   * finds. Raises when a stop, a search, or the provider's own limits leave the device rented, and
   * keeps the session recorded so the caller can retry the release.
   */
  release(request: Request, leaseId: string): Promise<Record<string, unknown> | undefined>;
  /** Stops every session this process holds and forgets only the confirmed stops. */
  shutdown(): Promise<void>;
}>;

type TrackedSession<Session> = {
  session: Session;
  /** The stop in flight, so a second release joins it instead of stopping one device twice. */
  releasing?: Promise<Record<string, unknown> | undefined>;
};

/** Every call this runtime is recording a lease for, so a drain can wait for all of them. */
type Pending = Set<Promise<unknown>>;

/**
 * Creates the lease-session table one provider runtime serves from. Every method is safe to call
 * concurrently: an allocation is recorded before it can be seen, so two callers asking for one lease
 * id share one device, and two releases of one session stop it once.
 */
export function createProviderLeaseSessionTable<Session, Lease, Request>(
  driver: ProviderLeaseSessionDriver<Session, Lease, Request>,
): ProviderLeaseSessionTable<Session, Request> {
  const sessions = new Map<string, TrackedSession<Session>>();
  const allocations = new Map<string, Promise<Record<string, unknown> | undefined>>();
  const recoveries = new Map<string, Promise<Record<string, unknown> | undefined>>();
  const pending: Pending = new Set();
  let shuttingDown = false;

  /** Builds the error one rejection reports, in the provider's own words. */
  function rejection(rejected: ProviderLeaseRejection): Error {
    return driver.reject(rejected, providerLeaseFailureReason(rejected));
  }

  /** Keeps a call visible to `shutdown` until it settles, and hands the caller its result. */
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.catch(() => undefined).then(() => pending.delete(work));
    return work;
  }

  /** Runs `rent` unless this lease id is already renting, in which case the caller joins it. */
  function startOrJoin(
    leaseId: string,
    request: Request,
    options: ProviderLeaseOptions | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    const joining = allocations.get(leaseId);
    if (joining) return joining;
    const running = track(rentDevice(leaseId, request, options));
    allocations.set(leaseId, running);
    // The record goes once it settles, so a later caller gets a fresh attempt, not an old rejection.
    void running
      .catch(() => undefined)
      .then(() => {
        if (allocations.get(leaseId) === running) allocations.delete(leaseId);
      });
    return running;
  }

  /** Checks the table is open, then reuses the session this lease id holds or rents a device. */
  async function runAllocation(
    leaseId: string,
    request: Request,
    options: ProviderLeaseOptions | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    if (shuttingDown) throw rejection({ reason: 'provider-runtime-shutting-down' });
    await driver.prepare?.(request, options ?? {});
    const held = sessions.get(leaseId);
    // A stop in flight decides whether a session survives: a confirmed one is gone and a new
    // caller rents afresh, an unconfirmed one left the device up and still worth serving.
    if (held?.releasing) await held.releasing.catch(() => undefined);
    const settled = sessions.get(leaseId);
    if (settled && !settled.releasing) return await driver.reuse(settled.session, request);
    return await startOrJoin(leaseId, request, options);
  }

  async function rentDevice(
    leaseId: string,
    request: Request,
    options: ProviderLeaseOptions | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    const { signal, deadlineAt } = options ?? {};
    let adopted: Session | undefined;
    let cancelled = signal?.aborted === true;
    const onCancel = (): void => {
      cancelled = true;
    };
    signal?.addEventListener('abort', onCancel, { once: true });
    let started: Record<string, unknown> | undefined;
    // A failure here is the provider's to report, and a rental this process never adopted is its to
    // give back. Whatever the provider did adopt stays recorded for a later release.
    try {
      started = await driver.start(request, {
        signal,
        deadlineAt,
        adopt: (session) => {
          adopted = session;
          sessions.set(leaseId, { session });
        },
      });
    } finally {
      signal?.removeEventListener('abort', onCancel);
    }
    // The caller is gone or stopped waiting while the device is rented, and it never learned the
    // handle. End it here, where this process still holds the session.
    const tracked = adopted ? sessions.get(leaseId) : undefined;
    if (tracked && tracked.session === adopted) {
      if (cancelled) {
        await stopSession(leaseId, tracked);
        throw rejection({ reason: 'provider-allocation-cancelled', leaseId });
      }
      if (deadlineAt !== undefined && Date.now() > deadlineAt) {
        await stopSession(leaseId, tracked);
        throw rejection({
          reason: 'provider-start-deadline-exceeded',
          leaseId,
          deadlineAt,
        });
      }
    }
    return started;
  }

  /** Stops one tracked session, joins the stop already running, and forgets only a confirmed one. */
  function stopSession(
    leaseId: string,
    tracked: TrackedSession<Session>,
  ): Promise<Record<string, unknown> | undefined> {
    if (tracked.releasing) return tracked.releasing;
    const stopping = track(stopAndForget(leaseId, tracked));
    tracked.releasing = stopping;
    return stopping;
  }

  async function stopAndForget(
    leaseId: string,
    tracked: TrackedSession<Session>,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      // Read before the stop: after an unconfirmed stop the session stays recorded, and a retry has
      // to report the same device rather than one this call already forgot.
      const artifacts = await driver.describeRelease(tracked.session);
      await driver.stop(tracked.session);
      if (sessions.get(leaseId) === tracked) sessions.delete(leaseId);
      return artifacts;
    } catch (error) {
      // The stop is unconfirmed, so the session is retryable and the artifacts still describe a
      // device somebody is paying for.
      tracked.releasing = undefined;
      throw rejection({ reason: 'provider-stop-unconfirmed', leaseId, cause: error });
    }
  }

  /** Ends the sessions serving a lease this process never started, joining a recovery already running. */
  function releaseForeign(
    request: Request,
    leaseId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const joining = recoveries.get(leaseId);
    if (joining) return joining;
    const running = track(endForeignSession(request, leaseId));
    recoveries.set(leaseId, running);
    void running
      .catch(() => undefined)
      .then(() => {
        if (recoveries.get(leaseId) === running) recoveries.delete(leaseId);
      });
    return running;
  }

  async function endForeignSession(
    request: Request,
    leaseId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const tracked = sessions.get(leaseId);
    if (tracked) return await stopSession(leaseId, tracked);
    let search: ProviderLeaseSearch<Lease>;
    try {
      search = await driver.searchLease(request);
    } catch (error) {
      throw rejection({ reason: 'provider-lease-search-unanswered', leaseId, cause: error });
    }
    if (search.status === 'unknown') {
      throw rejection({
        reason: 'provider-lease-search-unanswered',
        leaseId,
        cause: search.cause,
      });
    }
    if (search.status === 'absent') return undefined;
    const outcome = await driver.stopLease(search.lease);
    if (outcome === undefined) {
      throw rejection({ reason: 'provider-lease-not-releasable', leaseId });
    }
    if (!outcome.stopped) {
      throw rejection({ reason: 'provider-stop-unconfirmed', leaseId, cause: outcome.cause });
    }
    // A session may have been adopted while this search ran; it belongs to that allocation, which
    // reports its own device and releases it itself.
    return outcome.artifacts;
  }

  return {
    find(leaseId) {
      return sessions.get(leaseId)?.session;
    },
    allocate(request, leaseId, options) {
      // Registered before the first await: a drain that starts while this call is still asking the
      // provider has to see it, or it would finish while a rental is on its way.
      return track(runAllocation(leaseId, request, options));
    },
    release(request, leaseId) {
      const tracked = sessions.get(leaseId);
      return tracked ? stopSession(leaseId, tracked) : releaseForeign(request, leaseId);
    },
    async shutdown() {
      shuttingDown = true;
      // A rental in flight has to settle first: stopping a session mid-start leaves the device
      // running with no handle anywhere, and a release racing this drain has to be waited on too,
      // or a device deleted after this point would be reported as already gone.
      while (pending.size > 0) await Promise.allSettled(pending);
      const held = [...sessions];
      const outcomes = await Promise.all(
        held.map(async ([leaseId, tracked]) => {
          try {
            await stopSession(leaseId, tracked);
            return undefined;
          } catch {
            return leaseId;
          }
        }),
      );
      const unconfirmed = outcomes.filter((leaseId) => leaseId !== undefined);
      if (unconfirmed.length > 0) {
        throw rejection({ reason: 'provider-drain-unconfirmed', leaseIds: unconfirmed });
      }
    },
  };
}
