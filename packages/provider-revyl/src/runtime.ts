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
  REVYL_ALLOCATION_TIMEOUT_MS,
  revylCallerGaveUp,
  revylCleanupPending,
  startRevylSession,
  stopRevylSession,
  type RevylCallerBudget,
  type RevylRentedSession,
  type RevylSession,
} from './revyl-session.ts';
import {
  createProviderLeaseTable,
  type ProviderLeaseCleanupScope,
  type ProviderLeaseDriver,
  type ProviderLeaseTable,
} from '@agent-device/provision-kit/provider-lease-table';
import { createRevylInteractor } from './interactor.ts';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { resolveRevylRuntimeInstance } from './runtime-instance.ts';
import { revylSessionIdForLease } from './session-identity.ts';
import type { RevylStartRequest } from './session-allocation.ts';

/** What one lease's start asks Revyl for, with the platform the lease was admitted for. */
type RevylLeaseRequest = RevylStartRequest & Readonly<{ platform: RevylPlatform }>;

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
  private readonly options: RevylRuntimeOptions;
  /** Every lease this runtime rents a device for, until Revyl confirms that device's `/stop`. */
  private readonly leases: ProviderLeaseTable<RevylSession, RevylRentedSession, RevylLeaseRequest>;
  readonly provider = REVYL_PROVIDER;

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: (lease, context) => this.allocate(lease, context),
    release: async (lease) => await this.release(lease),
  };

  readonly recoverExpiredLease: ProviderExpiredLeaseRecovery = async (lease) => {
    requireRevylLease(lease, 'recover');
    await this.leases.recover(lease);
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider || !request.leaseId) return null;
    const session = this.leases.live(request.leaseId);
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
    const client = createRevylClient({
      apiKey: options.apiKey,
      ...(options.backendUrl === undefined ? {} : { backendUrl: options.backendUrl }),
      clientVersion: options.clientVersion,
    });
    this.leases = createProviderLeaseTable(createRevylLeaseDriver(client));
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

  async shutdown(): Promise<void> {
    await this.leases.shutdown();
  }

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
    const request: RevylLeaseRequest = {
      ...resolveRevylStartRequest(context, {
        ...(this.options.deviceModel === undefined
          ? {}
          : { deviceModel: this.options.deviceModel }),
        ...(this.options.osVersion === undefined ? {} : { osVersion: this.options.osVersion }),
      }),
      platform,
    };
    const session = await this.leases.allocate(lease, request, {
      ...revylCallerBudget(context),
      requireJoinable: (started) => requireSameRevylStartRequest(lease.leaseId, started, request),
    });
    return allocationResult(session);
  }

  /**
   * Ends the lease's session, or throws so the daemon keeps the release pending and retries it. A
   * device Revyl still holds is never reported as released.
   */
  private async release(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider || !platformForRevylLeaseBackend(lease.backend)) {
      return undefined;
    }
    const released = await this.leases.release(lease.leaseId);
    if (released === undefined) return undefined;
    return released.session
      ? allocationResult(released.session)
      : { providerSessionId: released.handle.sessionId };
  }

  private sessionForDevice(device: DeviceInfo): RevylSession | undefined {
    const parsed = parseRevylDeviceId(device.id);
    if (!parsed) return undefined;
    const session = this.leases.live(parsed.leaseId);
    return session?.platform === parsed.platform ? session : undefined;
  }
}

/**
 * What Revyl supplies to the lease table. A session is stopped by the id this runtime issued for its
 * lease, so that id is also what a lease this process never started is recovered by.
 */
function createRevylLeaseDriver(
  client: RevylClient,
): ProviderLeaseDriver<RevylSession, RevylRentedSession, RevylLeaseRequest> {
  return {
    startTimeoutMs: REVYL_ALLOCATION_TIMEOUT_MS,
    // A session is created when `start_device` answers, not when it is sent, so the issued id is never
    // published before that answer: a stop sent earlier reads as "already gone" and leaves the device.
    start: async (lease, request, control) => {
      const started = await startRevylSession(client, lease, {
        platform: request.platform,
        appUrl: request.appUrl,
        deviceModel: request.deviceModel,
        osVersion: request.osVersion,
        // The starting caller's signal is not passed on: callers that joined still want the device, and
        // the table stops it if nobody does once it is ready.
        ...(control.caller.deadline === undefined ? {} : { deadline: control.caller.deadline }),
      });
      if (started.status === 'failed') return started;
      const { runId, sessionId } = started.session;
      return { status: 'ready', session: started.session, handle: { runId, sessionId } };
    },
    stop: async (handle) => {
      try {
        await stopRevylSession(client, handle.sessionId);
      } catch (error) {
        // Revyl answers a session it no longer has as gone: that device is not rented.
        if (!isRevylSessionGone(error)) throw error;
      }
    },
    handleKey: (handle) => handle.sessionId,
    findByLease: async (lease) => ({ sessionId: revylSessionIdForLease(lease.leaseId) }),
    shuttingDown: (lease) => shuttingDownDuring(lease.leaseId, 'allocate'),
    releasing: (lease) =>
      new AppError('COMMAND_FAILED', `Revyl lease ${lease.leaseId} is being released.`, {
        reason: 'provider-lease-releasing',
        leaseId: lease.leaseId,
        hint: 'Connect again to rent a device under a new lease.',
      }),
    gaveUp: (lease, caller, budgetMs, rented) =>
      revylCallerGaveUp(
        revylLeasePlatform(lease),
        caller,
        budgetMs,
        rented?.sessionId ?? revylSessionIdForLease(lease.leaseId),
      ),
    cleanupPending: (unconfirmed, scope, cause) =>
      revylCleanupPending(
        unconfirmed.map((stop) => ({
          ...(stop.handle ?? { sessionId: revylSessionIdForLease(stop.leaseId) }),
          failure: errorMessage(stop.cause),
        })),
        revylCleanupDetails(scope),
        cause,
      ),
  };
}

/** Which lease or drain a cleanup report belongs to; a failed start's report names its session only. */
function revylCleanupDetails(scope: ProviderLeaseCleanupScope): Record<string, unknown> {
  switch (scope.route) {
    case 'shutdown':
      return { operation: 'shutdown' };
    case 'start':
      return {};
    case 'release':
    case 'recover':
      return { leaseId: scope.leaseId };
  }
}

/** The platform of a lease the runtime already admitted as Revyl's. */
function revylLeasePlatform(lease: DeviceLease): RevylPlatform {
  const platform = platformForRevylLeaseBackend(lease.backend);
  if (platform === undefined) {
    throw new AppError('UNSUPPORTED_OPERATION', 'Revyl cannot serve this lease.', {
      leaseId: lease.leaseId,
      leaseProvider: lease.leaseProvider,
      leaseBackend: lease.backend,
    });
  }
  return platform;
}

/**
 * The caller's own patience, read from the lease context it arrived with. The lease table cuts its
 * deadline to `REVYL_ALLOCATION_TIMEOUT_MS`.
 */
function revylCallerBudget(context?: LeaseLifecycleContext): RevylCallerBudget {
  return {
    ...(context?.signal === undefined ? {} : { signal: context.signal }),
    ...(context?.deadline === undefined ? {} : { deadline: context.deadline }),
  };
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
