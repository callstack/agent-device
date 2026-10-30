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
import { AppError } from '@agent-device/kernel/errors';
import {
  parseRevylDeviceId,
  platformForRevylLeaseBackend,
  REVYL_PROVIDER,
  type RevylPlatform,
} from './device.ts';
import { createRevylClient, type RevylClient } from './revyl-client.ts';
import { startRevylSession, stopRevylSession, type RevylSession } from './revyl-session.ts';
import { createRevylInteractor } from './interactor.ts';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { resolveRevylRuntimeInstance } from './runtime-instance.ts';
import { revylSessionIdForLease } from './session-identity.ts';

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

/** A release Revyl did not confirm, reported so the rented device is not lost. */
type RevylReleaseWarning = Readonly<{
  code: 'REVYL_SESSION_STOP_FAILED';
  message: string;
  providerSessionId: string;
}>;

/** What ending one lease's session amounted to: what to report, and what is still unconfirmed. */
type RevylReleaseOutcome = Readonly<{
  providerSessionId: string;
  warnings: RevylReleaseWarning[];
}>;

/** What one allocation produced, and whether this call is the one that took the device. */
type RevylAllocation = Readonly<{
  session: RevylSession;
  rentedNow: boolean;
}>;

/** How many confirmed releases are remembered, which is comfortably above a daemon's live leases. */
const CONFIRMED_RELEASE_MEMORY = 256;

/**
 * Builds the Revyl runtime, and with `includePlatformModule` the owner the host loads bindings
 * through. The owner module is loaded on first bind, so a session that only rents a device never
 * evaluates the platform-runtime graph.
 */
export function createRevylRuntime(
  options: RevylRuntimeOptions,
  mode: Readonly<{ includePlatformModule: true }>,
): RevylRuntimeRegistration;
export function createRevylRuntime(options: RevylRuntimeOptions): RevylRuntime;
export function createRevylRuntime(
  options: RevylRuntimeOptions,
  mode?: Readonly<{ includePlatformModule: true }>,
): RevylRuntime | RevylRuntimeRegistration {
  const runtime = new RevylRuntimeImplementation(options);
  if (!mode?.includePlatformModule) return runtime;
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
  /** One session per lease, keyed so a repeat allocation of a live lease reuses its device. */
  private readonly sessions = new Map<string, RevylSession>();
  /**
   * Leases whose release Revyl confirmed, oldest first and bounded. A repeat release reports the
   * release already made instead of asking Revyl for a session it no longer holds.
   */
  private readonly confirmedReleases = new Map<string, string>();
  /** Allocations that have not settled; shutdown waits for these before it stops anything. */
  private readonly inFlightAllocations = new Set<Promise<void>>();
  private shuttingDown = false;
  readonly provider = REVYL_PROVIDER;

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    // The in-flight entry is recorded before the first `await`, so a shutdown that races a start
    // cannot miss a device that is already being rented.
    allocate: (lease, context) => this.trackAllocation(lease, context),
    release: async (lease) => await this.release(lease),
  };

  readonly recoverExpiredLease: ProviderExpiredLeaseRecovery = async (lease) => {
    requireRevylLease(lease, 'recover');
    const { providerSessionId, warnings } = await this.stopLeaseSession(lease);
    // The daemon forgets a pending release once recovery resolves, so a stop Revyl did not confirm
    // has to keep the lease pending rather than report a device Revyl may still be holding.
    if (warnings.length > 0) {
      throw new AppError(
        'COMMAND_FAILED',
        `Revyl did not confirm the release of expired lease ${lease.leaseId}.`,
        {
          reason: 'provider-cleanup-pending',
          leaseId: lease.leaseId,
          providerSessionId,
          warnings,
          hint: `End the Revyl session ${providerSessionId}; the device stays rented and billed until it is.`,
        },
      );
    }
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider || !request.leaseId) return null;
    const session = this.sessions.get(request.leaseId);
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

  getInteractor(device: DeviceInfo, _runner?: RunnerContext): Interactor | undefined {
    const session = this.sessionForDevice(device);
    return session ? createRevylInteractor(session) : undefined;
  }

  /**
   * Ends every session this runtime holds and reports what it could not confirm. An allocation still
   * waiting for its device is awaited first: it has already rented one, and dropping it here would
   * leave that device running with nobody holding its id. A stop that failed keeps shutdown reported
   * as failed, which is how the host learns Revyl may still be billing.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.awaitInFlightAllocations();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const failures = (
      await Promise.allSettled(
        sessions.map(
          async (session) => await stopRevylSession(this.client, session.runId, session.sessionId),
        ),
      )
    ).filter((settled) => settled.status === 'rejected');
    if (failures.length === 0) return;
    throw new AppError(
      'COMMAND_FAILED',
      `Revyl did not release ${failures.length} of ${sessions.length} session(s) this runtime started.`,
      {
        reason: 'provider-cleanup-pending',
        providerSessionIds: sessions.map((session) => session.sessionId),
        causes: failures.map((settled) =>
          settled.status === 'rejected' ? describe(settled.reason) : '',
        ),
        hint: 'End the listed Revyl sessions; their devices stay rented and billed until they are.',
      },
    );
  }

  /** Registers one allocation as in flight, so {@link shutdown} either waits for it or refuses it. */
  private trackAllocation(
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ): Promise<Record<string, unknown> | undefined> {
    const run = this.runAllocation(lease, context);
    const inFlight = run.then(
      () => undefined,
      () => undefined,
    );
    this.inFlightAllocations.add(inFlight);
    return run.finally(() => {
      this.inFlightAllocations.delete(inFlight);
    });
  }

  /**
   * One allocation. A start that became ready while shutdown was already running has rented a device
   * no lease list holds, so it ends that device itself and reports the refusal rather than handing the
   * session to a runtime that is gone. A repeat allocation of a session the runtime already held needs
   * no such cleanup: shutdown stops that one with the rest.
   */
  private async runAllocation(
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ): Promise<Record<string, unknown> | undefined> {
    const allocated = await this.allocate(lease, context);
    if (allocated === undefined) return undefined;
    const { session, rentedNow } = allocated;
    if (!this.shuttingDown) {
      this.sessions.set(lease.leaseId, session);
      return allocationResult(session);
    }
    if (rentedNow) {
      await stopRevylSession(this.client, session.runId, session.sessionId).catch(() => undefined);
    }
    throw shuttingDownDuring(lease.leaseId, 'allocate');
  }

  /** Resolves once no allocation is in flight, so shutdown stops everything that exists. */
  private async awaitInFlightAllocations(): Promise<void> {
    const pending = [...this.inFlightAllocations];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
    await this.awaitInFlightAllocations();
  }

  /**
   * One allocation's session, with `rentedNow` naming whether this call is the one that took the
   * device. A lease of another provider, or of a backend Revyl has no device for, is answered with
   * nothing, which is how the core reads "this provider has no allocation to report".
   */
  private async allocate(
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ): Promise<RevylAllocation | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const platform = platformForRevylLeaseBackend(lease.backend);
    if (!platform) return undefined;
    const { rejectRefusedRevylProfileFields } = await import('./session-allocation.ts');
    // Before the reuse below: a repeat allocation of a live lease carries flags of its own, and
    // Revyl reads none of them a second time.
    rejectRefusedRevylProfileFields(context);
    if (this.shuttingDown) throw shuttingDownDuring(lease.leaseId, 'allocate');
    // A repeat allocation of a live lease is that same device, and Revyl is asked for nothing.
    const existing = this.sessions.get(lease.leaseId);
    if (existing) return { session: existing, rentedNow: false };
    return { session: await this.createSession(platform, lease, context), rentedNow: true };
  }

  /**
   * Starts the device. A start that never became ready is already cleaned up inside
   * `startRevylSession`, which stops the run it started before it reports the failure.
   */
  private async createSession(
    platform: RevylPlatform,
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ): Promise<RevylSession> {
    const { resolveRevylAppUrl, resolveRevylDeviceSelection } =
      await import('./session-allocation.ts');
    const selection = resolveRevylDeviceSelection(
      context,
      this.options.deviceModel === undefined && this.options.osVersion === undefined
        ? {}
        : {
            ...(this.options.deviceModel === undefined
              ? {}
              : { deviceModel: this.options.deviceModel }),
            ...(this.options.osVersion === undefined ? {} : { osVersion: this.options.osVersion }),
          },
    );
    return await startRevylSession(this.client, lease, {
      platform,
      appUrl: resolveRevylAppUrl(context),
      deviceModel: selection.deviceModel,
      osVersion: selection.osVersion,
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
      ...(context?.deadline === undefined ? {} : { deadline: context.deadline }),
    });
  }

  /**
   * Ends what one lease rented and reports the verdict instead of throwing it away: a stop Revyl
   * refused or never answered leaves a device under rent, and the caller has to hear that. The lease
   * keeps its session until the stop is confirmed, so the daemon's retry path retries the same
   * session rather than reporting a release that never happened.
   */
  private async release(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider || !platformForRevylLeaseBackend(lease.backend)) {
      return undefined;
    }
    const session = this.sessions.get(lease.leaseId);
    if (!session) {
      const confirmed = this.confirmedReleases.get(lease.leaseId);
      return confirmed === undefined ? undefined : { providerSessionId: confirmed };
    }
    const warning = await this.stopSession(session.runId, session.sessionId);
    if (warning) {
      return {
        ...allocationResult(session),
        warnings: [warning],
        hint: `End the Revyl session ${session.sessionId}; the device stays rented and billed until it is.`,
      };
    }
    this.sessions.delete(lease.leaseId);
    this.rememberRelease(lease.leaseId, session.sessionId);
    return allocationResult(session);
  }

  /**
   * Stops one lease's session whether or not this process started it. With no session in hand the id
   * is derived from the lease, which is the identity `start_device` was given for it, so a recovery
   * in a restarted daemon still names the session.
   */
  private async stopLeaseSession(lease: DeviceLease): Promise<RevylReleaseOutcome> {
    const session = this.sessions.get(lease.leaseId);
    const providerSessionId = session?.sessionId ?? revylSessionIdForLease(lease.leaseId);
    const warning = await this.stopSession(session?.runId, providerSessionId);
    if (!warning && session) {
      this.sessions.delete(lease.leaseId);
      this.rememberRelease(lease.leaseId, providerSessionId);
    }
    return { providerSessionId, warnings: warning === undefined ? [] : [warning] };
  }

  /** One stop, with Revyl's own "no such session" read as released: that device is not rented. */
  private async stopSession(
    runId: string | undefined,
    providerSessionId: string,
  ): Promise<RevylReleaseWarning | undefined> {
    try {
      await stopRevylSession(this.client, runId, providerSessionId);
      return undefined;
    } catch (error) {
      if (isRevylSessionGone(error)) return undefined;
      return {
        code: 'REVYL_SESSION_STOP_FAILED',
        message: describe(error),
        providerSessionId,
      };
    }
  }

  private rememberRelease(leaseId: string, providerSessionId: string): void {
    this.confirmedReleases.set(leaseId, providerSessionId);
    if (this.confirmedReleases.size <= CONFIRMED_RELEASE_MEMORY) return;
    const oldest = this.confirmedReleases.keys().next();
    if (!oldest.done) this.confirmedReleases.delete(oldest.value);
  }

  private sessionForDevice(device: DeviceInfo): RevylSession | undefined {
    const parsed = parseRevylDeviceId(device.id);
    if (!parsed) return undefined;
    const session = this.sessions.get(parsed.leaseId);
    return session?.platform === parsed.platform ? session : undefined;
  }
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

/** Revyl answers a stop for a session it no longer has with 404 or 410, which is a released device. */
function isRevylSessionGone(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === 'provider-session-gone';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
