import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleContext,
  LeaseLifecycleProvider,
  ProviderDeviceRuntime,
  ProviderExpiredLeaseRecovery,
} from '@agent-device/contracts/device';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { matchesPlatformSelector } from '@agent-device/kernel/device';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import {
  parseRevylDeviceId,
  platformForRevylLeaseBackend,
  REVYL_PROVIDER,
  type RevylPlatform,
} from './device.ts';
import { createRevylClient, isRevylSessionGone, type RevylClient } from './revyl-client.ts';
import {
  revylCallerGaveUp,
  revylCallerWait,
  revylCleanupPending,
  startRevylSession,
  stopRevylSession,
  type RevylCallerBudget,
  type RevylRentedSession,
  type RevylSession,
  type RevylStart,
} from './revyl-session.ts';
import { createRevylInteractor } from './interactor.ts';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { resolveRevylRuntimeInstance } from './runtime-instance.ts';
import { revylSessionIdForLease } from './session-identity.ts';
import type { RevylStartRequest } from './session-allocation.ts';

export type RevylRuntimeOptions = Readonly<{
  apiKey: string;
  /** Overrides the Revyl backend origin; unset uses the public backend. */
  backendUrl?: string;
  /** Sent in `User-Agent` so Revyl can attribute a session to the CLI that started it. */
  clientVersion: string;
  /**
   * The device model and OS version to request, from the connect profile. Revyl picks a device from
   * them when they are set and from its own default pool when they are not.
   */
  deviceModel?: string;
  osVersion?: string;
}>;

export type RevylRuntimeRegistration = Readonly<{
  runtime: RevylRuntime;
  platformModule: PlatformRuntimeProviderModule;
}>;

export type RevylRuntime = ProviderDeviceRuntime & {
  recoverExpiredLease: ProviderExpiredLeaseRecovery;
  hasLiveSession(device: DeviceInfo): boolean;
};

/** What one lease's start ended with, as the entry that owns its cleanup records it. */
type RevylStartOutcome =
  | Readonly<{ status: 'ready'; session: RevylSession }>
  | Readonly<{ status: 'failed'; error: unknown }>;

/** What ending one lease amounted to: the session Revyl was told to end, and what it left owed. */
type RevylStopOutcome = Readonly<{
  session: RevylRentedSession;
  /** The ended session's own report, so a release answers with the device it let go of. */
  data?: Record<string, unknown>;
  /** Why Revyl did not confirm the stop; absent once the device is no longer rented. */
  failure?: string;
}>;

/**
 * One lease's place in {@link RevylRuntimeImplementation.leases}: the start that rents its device, the
 * session that start produced, and the `/stop` that has not been confirmed yet.
 */
class RevylLeaseEntry {
  /** What the start was asked for, which a joining allocation has to ask for too. */
  readonly request: RevylStartRequest;
  /**
   * Settles once this lease's `start_device` has answered and the stop that a failed start owed has
   * settled with it, so a reader that awaits it cannot miss a rented device.
   */
  readonly start: Promise<RevylStartOutcome>;
  /** The live device, while this lease has one. */
  session: RevylSession | undefined;
  /** The session this start left under rent; absent while the request has not answered yet. */
  stop: RevylRentedSession | undefined;
  /** Whether Revyl confirmed `/stop` for {@link stop}. Only this lets the entry leave the map. */
  stopConfirmed: boolean;
  /**
   * The `/stop` in flight for {@link stop}, shared by every release, recovery and shutdown that arrives
   * while it runs, so Revyl sees one stop per attempt. Cleared once it settles, so a failed stop is
   * retried by the next caller.
   */
  stopping: Promise<string | undefined> | undefined;

  /**
   * `start` fills this entry in as it goes; it may write the entry's own fields, but it must never wait
   * on them, because the assignment below has not happened while its body first runs.
   */
  constructor(
    request: RevylStartRequest,
    start: (entry: RevylLeaseEntry) => Promise<RevylStartOutcome>,
  ) {
    this.request = request;
    this.session = undefined;
    this.stop = undefined;
    this.stopConfirmed = false;
    this.stopping = undefined;
    this.start = start(this);
  }
}

/**
 * Builds the Revyl runtime and the owner the host loads its bindings through. The owner's module is
 * loaded on first bind, so a session that only rents a device never evaluates the platform-runtime
 * graph.
 */
export function createRevylRuntime(options: RevylRuntimeOptions): RevylRuntimeRegistration {
  const runtime = new RevylRuntimeImplementation(options);
  const owner = providerRuntimeOwner(
    REVYL_PROVIDER,
    resolveRevylRuntimeInstance({
      apiKey: options.apiKey,
      ...(options.backendUrl === undefined ? {} : { backendUrl: options.backendUrl }),
    }),
  );
  if (owner.kind !== 'provider-runtime') throw new TypeError('Invalid Revyl runtime owner');
  return Object.freeze({
    runtime,
    platformModule: Object.freeze({
      owner,
      loadRuntime: async (host: PlatformRuntimeHost) =>
        await loadRevylPlatformRuntime(runtime, owner.instance, host),
    }),
  });
}

class RevylRuntimeImplementation implements ProviderDeviceRuntime {
  private readonly client: RevylClient;
  private readonly options: RevylRuntimeOptions;
  /**
   * A lease entry exists from the moment `start_device` is sent until Revyl confirms `/stop` for every
   * session that start produced. Only a confirmed stop removes it. Allocate, join, release, recovery and
   * shutdown all read and write this one entry; nothing else holds a cleanup handle.
   *
   * `start` is how every reader learns what the lease rented, including a start whose caller stopped
   * waiting for it: the request outlives that caller to learn what it rented, and until it answers,
   * nobody knows whether there is a device to stop. `stop` is what the entry owes, so an entry that is
   * still here is an unconfirmed release, and one that rented nothing is not here at all.
   */
  private readonly leases = new Map<string, RevylLeaseEntry>();
  private shuttingDown = false;
  readonly provider = REVYL_PROVIDER;

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: (lease, context) => this.allocate(lease, context),
    release: async (lease) => await this.release(lease),
  };

  readonly recoverExpiredLease: ProviderExpiredLeaseRecovery = async (lease) => {
    requireRevylLease(lease, 'recover');
    const entry = this.leases.get(lease.leaseId);
    // The daemon restarted and holds a persisted lease with no entry beside it. The id derived from the
    // lease is the only handle left, and Revyl answers a session it never had as gone.
    const derived = { sessionId: revylSessionIdForLease(lease.leaseId) };
    const outcome = entry
      ? await this.endLease(lease.leaseId, entry)
      : { session: derived, failure: await this.stopRented(derived) };
    // The daemon forgets a pending release once recovery resolves, so a stop Revyl did not confirm has to
    // keep the lease pending rather than report a device Revyl may still be holding.
    if (outcome?.failure !== undefined) throw revylReleasePending(lease.leaseId, outcome);
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider || !request.leaseId) return null;
    const session = this.leases.get(request.leaseId)?.session;
    if (!session) return null;
    // `--platform ios` names the same device as `--platform apple`, so the request is answered with
    // the platform selector's own rule rather than a field compare that would drop it.
    return matchesPlatformSelector(session.device, request.platform) ? [session.device] : [];
  };

  constructor(options: RevylRuntimeOptions) {
    if (!options.apiKey.trim()) {
      throw new TypeError('Revyl runtime requires an apiKey');
    }
    this.options = options;
    this.client = createRevylClient({
      apiKey: options.apiKey,
      ...(options.backendUrl === undefined ? {} : { backendUrl: options.backendUrl }),
      clientVersion: options.clientVersion,
    });
  }

  ownsDevice(device: DeviceInfo): boolean {
    return parseRevylDeviceId(device.id) !== undefined;
  }

  hasLiveSession(device: DeviceInfo): boolean {
    return this.sessionForDevice(device) !== undefined;
  }

  getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined {
    const session = this.sessionForDevice(device);
    // The runner carries the command's signal, so paced work (a delayed fill) stops when the caller
    // hangs up.
    return session ? createRevylInteractor(session, runner?.signal) : undefined;
  }

  /**
   * Ends every session this runtime holds and reports what it could not confirm. Every entry is awaited
   * first, whether or not its start has answered: a start already in flight has a device on its way, and
   * a start whose caller gave up is still owed the answer that names the device it rented. A stop that
   * failed keeps its entry in the map, so a release that follows, or a daemon that survives this
   * shutdown, retries the same session instead of recording a release Revyl never confirmed.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // Snapshot first: `allocate` refuses once the flag is set, and it does that before it sends anything,
    // so no entry can be added while this runs.
    const entries = [...this.leases.entries()];
    const outcomes = await Promise.all(
      entries.map(async ([leaseId, entry]) => await this.endLease(leaseId, entry)),
    );
    const unconfirmed = outcomes.flatMap((outcome) =>
      outcome?.failure === undefined ? [] : [{ ...outcome.session, failure: outcome.failure }],
    );
    if (unconfirmed.length === 0) return;
    throw revylCleanupPending(unconfirmed, { operation: 'shutdown' });
  }

  /**
   * One allocation of one lease. A lease already in the map is joined rather than started again, so two
   * allocations that overlap share the one device the first of them rents; a lease not in the map has its
   * entry registered before the request goes out, which is what makes it the only handle for what that
   * request rents.
   *
   * A caller that ran out of its own patience reports that, and leaves the entry alone: the device belongs
   * to every caller that joined the start, and the ones still waiting get the answer this one gave up on.
   */
  private async allocate(
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ): Promise<Record<string, unknown> | undefined> {
    const platform =
      lease.leaseProvider === this.provider
        ? platformForRevylLeaseBackend(lease.backend)
        : undefined;
    if (platform === undefined) return undefined;
    const {
      rejectRefusedRevylProfileFields,
      requireSameRevylStartRequest,
      resolveRevylStartRequest,
    } = await import('./session-allocation.ts');
    // Before the join below: an allocation that reuses a live lease still carries flags of its own,
    // and Revyl reads none of them — whether it starts a device or joins one that is starting.
    rejectRefusedRevylProfileFields(context);
    const request = resolveRevylStartRequest(context, {
      ...(this.options.deviceModel === undefined ? {} : { deviceModel: this.options.deviceModel }),
      ...(this.options.osVersion === undefined ? {} : { osVersion: this.options.osVersion }),
    });
    // Nothing between here and the entry's registration awaits, so one caller can never miss another's.
    if (this.shuttingDown) throw shuttingDownDuring(lease.leaseId, 'allocate');
    const existing = this.leases.get(lease.leaseId);
    if (existing) requireSameRevylStartRequest(lease.leaseId, existing.request, request);
    // The caller that started the device waits on it the same way a joiner does: one entry, one awaitable,
    // each caller bounded by its own patience.
    const entry = existing ?? this.rent(lease, platform, request, context);
    const outcome = await this.join(lease.leaseId, entry, platform, context);
    if (this.shuttingDown) {
      // The device this start rented is already an entry shutdown is ending, so this caller only reports
      // the refusal rather than handing a session to a runtime that is gone.
      throw shuttingDownDuring(lease.leaseId, 'allocate');
    }
    if (outcome.status === 'failed') throw outcome.error;
    return allocationResult(outcome.session);
  }

  /**
   * Rents the lease's device and returns the entry that owns what the request rents. The entry is in the
   * map before the first `await`, so an allocation that arrives mid-start joins it instead of renting a
   * second device, and a release that arrives then has somewhere to find the session.
   */
  private rent(
    lease: DeviceLease,
    platform: RevylPlatform,
    request: RevylStartRequest,
    context?: LeaseLifecycleContext,
  ) {
    const entry = new RevylLeaseEntry(request, (target) =>
      this.runStart(target, lease, platform, context),
    );
    this.leases.set(lease.leaseId, entry);
    return entry;
  }

  /**
   * Starts the lease's device, records what it rented in its entry, and ends from that entry a start that
   * never became ready — before the failure reaches the caller, so a failed allocate never leaves a device
   * running with only a later release to end it. A start Revyl refused outright rented nothing, so its
   * entry is closed rather than kept.
   */
  private async runStart(
    entry: RevylLeaseEntry,
    lease: DeviceLease,
    platform: RevylPlatform,
    context?: LeaseLifecycleContext,
  ): Promise<RevylStartOutcome> {
    const leaseId = lease.leaseId;
    let started: RevylStart;
    try {
      started = await startRevylSession(this.client, lease, {
        platform,
        appUrl: entry.request.appUrl,
        deviceModel: entry.request.deviceModel,
        osVersion: entry.request.osVersion,
        ...revylCallerBudget(context),
      });
    } catch (error) {
      // The start failed somewhere this module does not model, and the request may already have gone out,
      // so the id it carried is the handle the entry has to end.
      started = {
        status: 'failed',
        error,
        rented: { sessionId: revylSessionIdForLease(leaseId) },
      };
    }
    if (started.status === 'ready') {
      entry.session = started.session;
      entry.stop = { runId: started.session.runId, sessionId: started.session.sessionId };
      return { status: 'ready', session: started.session };
    }
    const rented = started.rented;
    // Revyl settled with a refusal: no session came of this start, so the entry owes nothing and is not
    // kept for a stop that would only answer 404.
    if (rented === undefined) {
      entry.stopConfirmed = true;
      this.closeLease(leaseId, entry);
      return { status: 'failed', error: started.error };
    }
    entry.stop = rented;
    // The entry ends what a failed start rented rather than waiting for a release to ask: the device is
    // billed from the moment Revyl made it, and this is the first moment its id is known.
    const failure = await this.stopOwed(entry, rented);
    if (failure === undefined) {
      entry.stopConfirmed = true;
      this.closeLease(leaseId, entry);
      return { status: 'failed', error: started.error };
    }
    // What is still billed outranks why the start did not finish, so the stop's failure is reported with
    // the session id that has to be ended by hand.
    return {
      status: 'failed',
      error: revylCleanupPending([{ ...rented, failure }], {}, started.error),
    };
  }

  /**
   * Joins the start another caller already has running for this lease, within this caller's own budget.
   * Hanging up here never stops that start and never closes the entry: this caller took no device, so it
   * ends none, and the callers still waiting are owed the same answer.
   */
  private async join(
    leaseId: string,
    entry: RevylLeaseEntry,
    platform: RevylPlatform,
    context?: LeaseLifecycleContext,
  ): Promise<RevylStartOutcome> {
    const live = entry.session;
    // A repeat allocation of a session this runtime already holds is that same device, and Revyl is asked
    // for nothing.
    if (live) return { status: 'ready', session: live };
    const budget = revylCallerBudget(context);
    // The number the report names is the wait this caller was granted, so it is measured from the moment
    // the join started rather than from the deadline's own epoch instant.
    const joinedAt = Date.now();
    const gaveUp = revylCallerWait<never>(budget.deadline ?? Number.POSITIVE_INFINITY, budget, () =>
      revylCallerGaveUp(
        platform,
        budget,
        Math.max(0, (budget.deadline ?? joinedAt) - joinedAt),
        entry.stop?.sessionId ?? revylSessionIdForLease(leaseId),
      ),
    );
    if (gaveUp === undefined) return await entry.start;
    try {
      return await Promise.race([entry.start, gaveUp.promise]);
    } finally {
      gaveUp.dispose();
    }
  }

  /**
   * Ends one entry: waits for its start, sends the `/stop` it owes, and closes it only when Revyl confirms
   * the session is gone. Every path that ends a device comes through here, so an unconfirmed stop stays in
   * the map for the next release, recovery, or shutdown to retry on the same session.
   *
   * The wait is what makes a release that lands mid-start stop the device that start rents. A release
   * arrives that way when the daemon drops a lease whose caller is gone while a caller still waits for the
   * shared start.
   */
  private async endLease(
    leaseId: string,
    entry: RevylLeaseEntry,
  ): Promise<RevylStopOutcome | undefined> {
    await entry.start;
    const target = entry.stop;
    // Nothing owed means nothing rented: the start was refused, or its stop is already confirmed.
    if (target === undefined) return undefined;
    const session = entry.session;
    // A failed start has already ended its own session before this point, and a caller that releases such
    // a lease must not make Revyl see a second stop for a session already gone.
    const failure = entry.stopConfirmed ? undefined : await this.stopOwed(entry, target);
    if (failure === undefined) {
      entry.stopConfirmed = true;
      this.closeLease(leaseId, entry);
    }
    return {
      session: target,
      ...(session === undefined ? {} : { data: allocationResult(session) }),
      ...(failure === undefined ? {} : { failure }),
    };
  }

  /** Removes an entry once Revyl has confirmed its stop, and only while it is still the map's entry. */
  private closeLease(leaseId: string, entry: RevylLeaseEntry): void {
    if (this.leases.get(leaseId) === entry) this.leases.delete(leaseId);
  }

  /**
   * Ends the lease's session and reports what is still owed, or throws so the daemon keeps the release
   * pending and retries it. A device Revyl still holds is never reported as released.
   */
  private async release(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider || !platformForRevylLeaseBackend(lease.backend)) {
      return undefined;
    }
    const entry = this.leases.get(lease.leaseId);
    // No entry means nothing is owed: this lease never rented, or a confirmed stop already closed it, and
    // Revyl is not asked again for a release it has already confirmed.
    if (!entry) return undefined;
    const outcome = await this.endLease(lease.leaseId, entry);
    if (outcome === undefined) return undefined;
    if (outcome.failure !== undefined) throw revylReleasePending(lease.leaseId, outcome);
    return outcome.data ?? { providerSessionId: outcome.session.sessionId };
  }

  /** The entry's one in-flight `/stop`, started by the first caller and joined by the rest. */
  private stopOwed(
    entry: RevylLeaseEntry,
    target: RevylRentedSession,
  ): Promise<string | undefined> {
    entry.stopping ??= this.stopRented(target).finally(() => {
      entry.stopping = undefined;
    });
    return entry.stopping;
  }

  /**
   * One `/stop`, with Revyl's own "no such session" read as released: that device is not rented. The
   * failure's message is what the caller reports; `undefined` is the confirmation the entry needs.
   */
  private async stopRented(target: RevylRentedSession): Promise<string | undefined> {
    try {
      await stopRevylSession(this.client, target.sessionId);
      return undefined;
    } catch (error) {
      return isRevylSessionGone(error) ? undefined : errorMessage(error);
    }
  }

  private sessionForDevice(device: DeviceInfo): RevylSession | undefined {
    const parsed = parseRevylDeviceId(device.id);
    if (!parsed) return undefined;
    const session = this.leases.get(parsed.leaseId)?.session;
    return session?.platform === parsed.platform ? session : undefined;
  }
}

/**
 * The caller's own patience, read from the lease context it arrived with. A caller that names neither
 * waits for whatever the work takes.
 */
function revylCallerBudget(context?: LeaseLifecycleContext): RevylCallerBudget {
  return {
    ...(context?.signal === undefined ? {} : { signal: context.signal }),
    ...(context?.deadline === undefined ? {} : { deadline: context.deadline }),
  };
}

/** The failure for a release Revyl did not confirm, with the session an operator has to end by hand. */
function revylReleasePending(leaseId: string, outcome: RevylStopOutcome): AppError {
  return revylCleanupPending([{ ...outcome.session, failure: outcome.failure ?? '' }], { leaseId });
}

/** Recovery and lifecycle calls arrive for one provider's lease; anything else is a routing bug. */
function requireRevylLease(lease: DeviceLease, operation: 'recover' | 'release'): void {
  if (lease.leaseProvider === REVYL_PROVIDER && platformForRevylLeaseBackend(lease.backend)) return;
  throw new AppError('UNSUPPORTED_OPERATION', `Revyl cannot ${operation} this expired lease.`, {
    leaseId: lease.leaseId,
    leaseProvider: lease.leaseProvider,
    leaseBackend: lease.backend,
  });
}

function shuttingDownDuring(leaseId: string, operation: string): AppError {
  return new AppError('COMMAND_FAILED', `The Revyl runtime is shutting down.`, {
    reason: 'runtime-shutting-down',
    operation,
    leaseId,
    hint: 'Retry the command; the daemon is ending the sessions it holds.',
  });
}

async function loadRevylPlatformRuntime(
  runtime: RevylRuntimeImplementation,
  runtimeInstance: string,
  host: PlatformRuntimeHost,
): Promise<PlatformRuntimeOwner> {
  const { createRevylPlatformRuntimeOwner } = await import('./platform-runtime.ts');
  return createRevylPlatformRuntimeOwner({
    host,
    runtimeInstance,
    ownsDevice: (device) => runtime.ownsDevice(device),
    hasLiveSession: (device) => runtime.hasLiveSession(device),
    getInteractor: (device, runner) => runtime.getInteractor(device, runner),
  });
}

/**
 * What the lease lifecycle reports for one session. The core reads `providerSessionId` to record the
 * provider session and the device to address the rented device from then on.
 */
function allocationResult(session: RevylSession): Record<string, unknown> {
  return {
    revylRunId: session.runId,
    providerSessionId: session.sessionId,
    device: session.device,
  };
}
