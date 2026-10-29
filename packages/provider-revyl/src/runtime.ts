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

export type RevylRuntimeOptions = Readonly<{
  apiKey: string;
  /** Overrides the Revyl backend origin; unset uses the public backend. */
  backendUrl?: string;
  /** Sent in `User-Agent` so Revyl can attribute a session to the CLI that started it. */
  clientVersion: string;
  /** Injectable for tests; production uses the global `fetch`. */
  fetch?: typeof fetch;
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
  readonly provider = REVYL_PROVIDER;

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease, context) => await this.allocate(lease, context),
    release: async (lease) => await this.release(lease),
  };

  readonly recoverExpiredLease: ProviderExpiredLeaseRecovery = async (lease) => {
    if (lease.leaseProvider !== this.provider || !platformForRevylLeaseBackend(lease.backend)) {
      throw new AppError('UNSUPPORTED_OPERATION', 'Revyl cannot recover this expired lease.', {
        leaseId: lease.leaseId,
        leaseProvider: lease.leaseProvider,
        leaseBackend: lease.backend,
      });
    }
    await this.release(lease);
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
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
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

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    // Each stop is idempotent and a failure to reach the backend must not keep the daemon up.
    await Promise.allSettled(
      sessions.map(
        async (session) => await stopRevylSession(this.client, session.runId, session.sessionId),
      ),
    );
  }

  private async allocate(
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const platform = platformForRevylLeaseBackend(lease.backend);
    if (!platform) return undefined;
    const { rejectRefusedRevylProfileFields } = await import('./session-allocation.ts');
    // Before the reuse below: a repeat allocation of a live lease carries flags of its own, and
    // Revyl reads none of them a second time.
    rejectRefusedRevylProfileFields(context);
    const existing = this.sessions.get(lease.leaseId);
    if (existing) return allocationResult(existing);

    const session = await this.createSession(platform, lease, context);
    this.sessions.set(lease.leaseId, session);
    return allocationResult(session);
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
    });
  }

  private async release(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    const session = this.sessions.get(lease.leaseId);
    if (!session) return undefined;
    this.sessions.delete(lease.leaseId);
    await stopRevylSession(this.client, session.runId, session.sessionId);
    return allocationResult(session);
  }

  private sessionForDevice(device: DeviceInfo): RevylSession | undefined {
    const parsed = parseRevylDeviceId(device.id);
    if (!parsed) return undefined;
    const session = this.sessions.get(parsed.leaseId);
    return session?.platform === parsed.platform ? session : undefined;
  }
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
    providerSessionId: session.sessionId ?? session.runId,
    device: session.device,
  };
}
