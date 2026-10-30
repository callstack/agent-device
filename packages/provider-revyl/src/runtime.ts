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
  startRevylSession,
  stopRevylSession,
  type RevylCallerBudget,
  type RevylSession,
} from './revyl-session.ts';
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
  /** One session per lease, keyed so a repeat allocation of a live lease reuses its device. */
  private readonly sessions = new Map<string, RevylSession>();
  /**
   * Leases whose release Revyl confirmed, oldest first and bounded. A repeat release reports the
   * release already made instead of asking Revyl for a session it no longer holds.
   */
  private readonly confirmedReleases = new Map<string, string>();
  /** Allocations that have not settled; shutdown waits for these before it stops anything. */
  private readonly inFlightAllocations = new Set<Promise<void>>();
  /**
   * One entry per lease whose device is being rented, kept until the session reaches the table. A second
   * allocation of that lease joins it rather than renting a device nobody will stop.
   */
  private readonly pendingAllocations = new Map<string, Promise<RevylAllocation>>();
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

  getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined {
    const session = this.sessionForDevice(device);
    // The runner's signal is the command's cancellation: paced work (a delayed fill) stops on it
    // instead of typing on after the caller hung up.
    return session ? createRevylInteractor(session, runner?.signal) : undefined;
  }

  /**
   * Ends every session this runtime holds and reports what it could not confirm. An allocation still
   * waiting for its device is awaited first: it has already rented one, and dropping it here would
   * leave that device running with nobody holding its id. A stop that failed keeps its lease in the
   * table, so a later release, or a daemon that survives this shutdown, can retry the same session
   * instead of recording a release Revyl never confirmed.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.awaitInFlightAllocations();
    const sessions = [...this.sessions.entries()];
    const outcomes = await Promise.all(
      sessions.map(async ([leaseId, session]) => {
        // `stopSession` reads Revyl's "no such session" as released; anything else keeps the lease.
        const warning = await this.stopSession(session.runId, session.sessionId);
        if (warning === undefined) {
          this.sessions.delete(leaseId);
          this.rememberRelease(leaseId, session.sessionId);
        }
        return { sessionId: session.sessionId, warning };
      }),
    );
    const unconfirmed = outcomes.filter((outcome) => outcome.warning !== undefined);
    if (unconfirmed.length === 0) return;
    throw new AppError(
      'COMMAND_FAILED',
      `Revyl did not release ${unconfirmed.length} of ${sessions.length} session(s) this runtime started.`,
      {
        reason: 'provider-cleanup-pending',
        providerSessionIds: unconfirmed.map((outcome) => outcome.sessionId),
        causes: unconfirmed.map((outcome) => outcome.warning?.message ?? ''),
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
    const allocated = await this.allocateOncePerLease(lease, context);
    if (allocated === undefined) return undefined;
    const { session, rentedNow } = allocated;
    if (!this.shuttingDown) return allocationResult(session);
    if (rentedNow) {
      await stopRevylSession(this.client, session.runId, session.sessionId).catch(() => undefined);
    }
    throw shuttingDownDuring(lease.leaseId, 'allocate');
  }

  /**
   * One device per lease. Two allocations that arrive before either finishes would otherwise each rent
   * a device, and the second session would replace the first in the table and leave it running with
   * nothing pointing at it; the second call joins the first instead. The session reaches the table while
   * the start is still registered, so a third allocation cannot arrive in the gap between one finishing
   * and the other learning about it and rent a device of its own.
   *
   * A caller joins only after its own flags are refused and its own budget is installed, so joining
   * neither accepts a profile Revyl would ignore nor inherits the patience of the caller that started
   * first.
   */
  private async allocateOncePerLease(
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ): Promise<RevylAllocation | undefined> {
    const platform =
      lease.leaseProvider === this.provider
        ? platformForRevylLeaseBackend(lease.backend)
        : undefined;
    if (platform === undefined) return undefined;
    const { rejectRefusedRevylProfileFields } = await import('./session-allocation.ts');
    // Before the join below: an allocation that reuses a live lease still carries flags of its own,
    // and Revyl reads none of them — whether it starts a device or joins one that is starting.
    rejectRefusedRevylProfileFields(context);
    const pending = this.pendingAllocations.get(lease.leaseId);
    if (pending) return await this.joinAllocation(pending, platform, context);
    const starting = this.allocate(lease, platform, context);
    this.pendingAllocations.set(lease.leaseId, starting);
    try {
      const allocated = await starting;
      // Recorded while the start is still registered, so no allocation can arrive in the gap after it
      // and rent a device of its own.
      if (!this.shuttingDown) this.sessions.set(lease.leaseId, allocated.session);
      return allocated;
    } finally {
      this.pendingAllocations.delete(lease.leaseId);
    }
  }

  /**
   * Waits for the start another caller already has running for this lease, within this caller's own
   * budget. Hanging up here never stops that start: the device belongs to every caller that joined it, so
   * this one reports its own cancellation or its own expired deadline and the start runs on for the
   * callers still waiting. A joiner never took the device, so it never ends it either way.
   */
  private async joinAllocation(
    pending: Promise<RevylAllocation>,
    platform: RevylPlatform,
    context?: LeaseLifecycleContext,
  ): Promise<RevylAllocation> {
    const budget = revylCallerBudget(context);
    // The number the report names is the wait this caller was granted, so it is measured from the moment
    // the join started rather than from the deadline's own epoch instant.
    const joinedAt = Date.now();
    const gaveUp = revylCallerWait<never>(budget.deadline ?? Number.POSITIVE_INFINITY, budget, () =>
      revylCallerGaveUp(platform, budget, Math.max(0, (budget.deadline ?? joinedAt) - joinedAt)),
    );
    if (gaveUp === undefined) return await joinOf(pending);
    try {
      return await joinOf(Promise.race([pending, gaveUp.promise]));
    } finally {
      gaveUp.dispose();
    }
  }

  /** Resolves once no allocation is in flight, so shutdown stops everything that exists. */
  private async awaitInFlightAllocations(): Promise<void> {
    const pending = [...this.inFlightAllocations];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
    await this.awaitInFlightAllocations();
  }

  /**
   * One allocation's session, with `rentedNow` naming whether this call is the one that took the device.
   * The lease is already known to be Revyl's, and its context already refused, by the caller above.
   */
  private async allocate(
    lease: DeviceLease,
    platform: RevylPlatform,
    context?: LeaseLifecycleContext,
  ): Promise<RevylAllocation> {
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
      ...revylCallerBudget(context),
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
        message: errorMessage(error),
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

/**
 * What a joined allocation reports: the device the caller that started it rented, which this call did
 * not take and therefore does not owe ending.
 */
async function joinOf(pending: Promise<RevylAllocation>): Promise<RevylAllocation> {
  return { ...(await pending), rentedNow: false };
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
