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
import {
  rejectRefusedRevylProfileFields,
  requireSameRevylStartRequest,
  resolveRevylStartRequest,
  type RevylStartRequest,
} from './session-allocation.ts';
import { RevylLeaseOwner, allocationResult, type RevylStopOutcome } from './lease-owner.ts';

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
  private readonly leases = new Map<string, RevylLeaseOwner>();
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
    if (entry) {
      const outcome = await entry.end();
      if (outcome?.cleanup === 'uncertain') throw revylReleasePending(lease.leaseId, outcome);
      return;
    }
    const failure = await this.stopRented(derived);
    if (failure !== undefined)
      throw revylReleasePending(lease.leaseId, { session: derived, cleanup: 'uncertain', failure });
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
    const outcomes = await Promise.all(entries.map(async ([, entry]) => await entry.end()));
    const unconfirmed = outcomes.flatMap((outcome) =>
      outcome?.cleanup !== 'uncertain' ? [] : [{ ...outcome.session, failure: outcome.failure }],
    );
    if (unconfirmed.length === 0) return;
    throw revylCleanupPending(unconfirmed, { operation: 'shutdown', cleanup: 'uncertain' });
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
    if (entry.releasing) throw releasingLease(lease.leaseId);
    const outcome =
      entry.session === undefined
        ? await this.join(lease.leaseId, entry, platform, context)
        : { status: 'ready' as const, session: entry.session };
    if (this.shuttingDown) {
      // The device this start rented is already an entry shutdown is ending, so this caller only reports
      // the refusal rather than handing a session to a runtime that is gone.
      throw shuttingDownDuring(lease.leaseId, 'allocate');
    }
    if (outcome.status === 'failed') {
      const stopped = await entry.endFailedStart();
      if (stopped?.cleanup === 'uncertain')
        throw revylReleasePending(lease.leaseId, stopped, outcome.error);
      throw outcome.error;
    }
    const session = entry.session;
    if (session === undefined) throw releasingLease(lease.leaseId);
    return allocationResult(session);
  }

  private rent(
    lease: DeviceLease,
    platform: RevylPlatform,
    request: RevylStartRequest,
    context?: LeaseLifecycleContext,
  ): RevylLeaseOwner {
    const entry = new RevylLeaseOwner(this.client, lease, platform, request, context, () => {
      if (this.leases.get(lease.leaseId) === entry) this.leases.delete(lease.leaseId);
    });
    this.leases.set(lease.leaseId, entry);
    return entry;
  }

  /**
   * Joins the start another caller already has running for this lease, within this caller's own budget.
   * Hanging up here never stops that start and never closes the entry: this caller took no device, so it
   * ends none, and the callers still waiting are owed the same answer.
   */
  private async join(
    leaseId: string,
    entry: RevylLeaseOwner,
    platform: RevylPlatform,
    context?: LeaseLifecycleContext,
  ): Promise<RevylStart> {
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
        revylSessionIdForLease(leaseId),
      ),
    );
    if (gaveUp === undefined) return await entry.creation;
    try {
      return await Promise.race([entry.creation, gaveUp.promise]);
    } finally {
      gaveUp.dispose();
    }
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
    const outcome = await entry.end();
    if (outcome === undefined) return undefined;
    if (outcome.cleanup === 'uncertain') throw revylReleasePending(lease.leaseId, outcome);
    return outcome.data ?? { providerSessionId: outcome.session.sessionId };
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
function revylReleasePending(
  leaseId: string,
  outcome: RevylStopOutcome,
  cause?: unknown,
): AppError {
  return revylCleanupPending(
    [{ ...outcome.session, failure: outcome.cleanup === 'uncertain' ? outcome.failure : '' }],
    { leaseId, cleanup: 'uncertain' },
    cause,
  );
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

function releasingLease(leaseId: string): AppError {
  return new AppError('DEVICE_IN_USE', 'The Revyl lease is being released.', {
    reason: 'provider-lease-releasing',
    leaseId,
    retriable: true,
    hint: 'Retry after the pending release is confirmed.',
  });
}
