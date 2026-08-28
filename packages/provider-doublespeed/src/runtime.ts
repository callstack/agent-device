import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleProvider,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
  ProviderExpiredLeaseRecovery,
} from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { DOUBLESPEED_CLIENT_HEADER, DoublespeedApiClient } from './api-client.ts';
import type { DoublespeedAppLogDescriptor } from './app-log-descriptor.ts';
import type { DoublespeedAppLogReader } from './app-log-poller.ts';
import {
  buildDoublespeedDevice,
  DOUBLESPEED_PROVIDER,
  isDoublespeedLeaseBackend,
  parseDoublespeedDeviceId,
} from './device.ts';
import { createDoublespeedDeviceSession, type DoublespeedDeviceSession } from './device-session.ts';
import {
  createDoublespeedIosInteractor,
  createDoublespeedIosSession,
  installDoublespeedIosApp,
  type DoublespeedIosSession,
} from './ios.ts';
import type { DoublespeedRuntimeDependencies } from './runtime-dependencies.ts';
import { resolveDoublespeedRuntimeInstance } from './runtime-instance.ts';

export type DoublespeedRuntimeOptions = {
  apiKey: string;
  apiUrl?: string;
  /** Simulator model name, e.g. `iPhone 16 Pro`; the service default applies when omitted. */
  device?: string;
  runtimeInstance?: string;
};

export type DoublespeedRuntime = ProviderDeviceRuntime & {
  recoverExpiredLease: ProviderExpiredLeaseRecovery;
  getDeviceSession(device: DeviceInfo): DoublespeedDeviceSession | undefined;
};

export type DoublespeedRuntimeRegistration = Readonly<{
  runtime: DoublespeedRuntime;
  platformModule: PlatformRuntimeProviderModule;
}>;

export function createDoublespeedRuntime(
  options: DoublespeedRuntimeOptions,
  dependencies: DoublespeedRuntimeDependencies,
  mode: Readonly<{ includePlatformModule: true }>,
): DoublespeedRuntimeRegistration;
export function createDoublespeedRuntime(
  options: DoublespeedRuntimeOptions,
  dependencies: DoublespeedRuntimeDependencies,
): DoublespeedRuntime;
export function createDoublespeedRuntime(
  options: DoublespeedRuntimeOptions,
  dependencies: DoublespeedRuntimeDependencies,
  mode?: Readonly<{ includePlatformModule: true }>,
): DoublespeedRuntime | DoublespeedRuntimeRegistration {
  const runtime = new DoublespeedRuntimeImplementation(options, dependencies);
  if (!mode?.includePlatformModule) return runtime;
  const owner = providerRuntimeOwner(
    DOUBLESPEED_PROVIDER,
    resolveDoublespeedRuntimeInstance(options),
  );
  if (owner.kind !== 'provider-runtime') throw new TypeError('Invalid Doublespeed runtime owner');
  return Object.freeze({
    runtime,
    platformModule: Object.freeze({
      owner,
      loadRuntime: async (host: PlatformRuntimeHost) =>
        await loadDoublespeedPlatformRuntime(runtime, owner.instance, host),
    }),
  });
}

class DoublespeedRuntimeImplementation implements ProviderDeviceRuntime {
  private readonly api: DoublespeedApiClient;
  private readonly sessions = new Map<string, DoublespeedIosSession>();
  private readonly options: DoublespeedRuntimeOptions;
  private readonly dependencies: DoublespeedRuntimeDependencies;
  readonly provider = DOUBLESPEED_PROVIDER;

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease) => await this.allocate(lease),
    release: async (lease) => await this.release(lease),
  };

  readonly recoverExpiredLease: ProviderExpiredLeaseRecovery = async (lease) => {
    if (lease.leaseProvider !== this.provider || !isDoublespeedLeaseBackend(lease.backend)) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Doublespeed cannot recover this expired lease.',
        {
          leaseId: lease.leaseId,
          leaseProvider: lease.leaseProvider,
          leaseBackend: lease.backend,
        },
      );
    }
    await this.release(lease);
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider || !request.leaseId) return null;
    const session = this.sessions.get(request.leaseId);
    if (!session) return null;
    if (request.platform && request.platform !== 'ios') return [];
    return [session.device];
  };

  constructor(options: DoublespeedRuntimeOptions, dependencies: DoublespeedRuntimeDependencies) {
    this.options = options;
    this.dependencies = dependencies;
    this.api = new DoublespeedApiClient({
      apiKey: options.apiKey,
      apiUrl: options.apiUrl,
      clientVersion: dependencies.clientVersion,
    });
  }

  ownsDevice(device: DeviceInfo): boolean {
    return parseDoublespeedDeviceId(device.id) !== undefined;
  }

  hasLiveSession(device: DeviceInfo): boolean {
    return this.getSessionForDevice(device) !== undefined;
  }

  getInteractor(device: DeviceInfo, _runner?: RunnerContext): Interactor | undefined {
    const session = this.getSessionForDevice(device);
    return session ? createDoublespeedIosInteractor(session) : undefined;
  }

  getDeviceSession(device: DeviceInfo): DoublespeedDeviceSession | undefined {
    const session = this.getSessionForDevice(device);
    return session ? createDoublespeedDeviceSession(session) : undefined;
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
    signal?: AbortSignal,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.installInstallablePath(
      device,
      appPath,
      { ...options, appIdentifierHint: options?.appIdentifierHint ?? app },
      signal,
    );
  }

  async installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
    signal?: AbortSignal,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    return await installDoublespeedIosApp(this.api, session, installablePath, options, signal);
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map(async (session) => await this.terminateSession(session)));
    this.sessions.clear();
  }

  private async allocate(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider || !isDoublespeedLeaseBackend(lease.backend)) {
      return undefined;
    }
    const existing = this.sessions.get(lease.leaseId);
    if (existing) return { doublespeedSimulatorId: existing.simulatorId, device: existing.device };

    const simulator = await this.api.createSimulator({
      device: this.options.device,
      labels: this.buildLabels(lease),
    });
    try {
      if (!simulator.api_url || !simulator.screen) {
        throw new AppError('COMMAND_FAILED', 'Doublespeed simulator did not expose a session API');
      }
      const session = createDoublespeedIosSession(
        {
          lease,
          simulatorId: simulator.id,
          device: buildDoublespeedDevice(lease, simulator),
          apiUrl: simulator.api_url,
          screen: simulator.screen,
        },
        this.dependencies,
      );
      this.sessions.set(lease.leaseId, session);
      return { doublespeedSimulatorId: session.simulatorId, device: session.device };
    } catch (error) {
      await this.api.deleteSimulator(simulator.id).catch(() => {});
      throw error;
    }
  }

  private buildLabels(lease: DeviceLease): Record<string, string> {
    return {
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseId: lease.leaseId,
      provider: lease.leaseProvider ?? DOUBLESPEED_PROVIDER,
      source: DOUBLESPEED_CLIENT_HEADER,
    };
  }

  private async release(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    const session = this.sessions.get(lease.leaseId);
    if (!session) return await this.releaseRecoveredSession(lease);
    await this.terminateSession(session);
    this.sessions.delete(lease.leaseId);
    return { doublespeedSimulatorId: session.simulatorId };
  }

  private async releaseRecoveredSession(
    lease: DeviceLease,
  ): Promise<Record<string, unknown> | undefined> {
    if (!isDoublespeedLeaseBackend(lease.backend)) return undefined;
    const simulators = await this.api.listSimulators({
      provider: DOUBLESPEED_PROVIDER,
      leaseId: lease.leaseId,
    });
    for (const simulator of simulators) await this.api.deleteSimulator(simulator.id);
    if (simulators.length === 0) return undefined;
    return {
      doublespeedSimulatorId: simulators[0]?.id,
      doublespeedSimulatorCount: simulators.length,
    };
  }

  private async terminateSession(session: DoublespeedIosSession): Promise<void> {
    await this.api.deleteSimulator(session.simulatorId);
  }

  private getSessionForDevice(device: DeviceInfo): DoublespeedIosSession | undefined {
    const parsed = parseDoublespeedDeviceId(device.id);
    return parsed ? this.sessions.get(parsed.leaseId) : undefined;
  }

  currentAppLogReader(device: DeviceInfo): DoublespeedAppLogReader | undefined {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    const deviceSession = createDoublespeedDeviceSession(session);
    return {
      leaseId: session.lease.leaseId,
      simulatorId: session.simulatorId,
      readLogs: async (appBundleId, lineLimit) =>
        await deviceSession.readLogs(appBundleId, lineLimit),
      [Symbol.asyncDispose]: async () => undefined,
    };
  }

  async reconnectAppLogReader(descriptor: DoublespeedAppLogDescriptor, signal?: AbortSignal) {
    const { reconnectDoublespeedAppLogReader } = await import('./app-log-reconnect.ts');
    return await reconnectDoublespeedAppLogReader({ api: this.api, descriptor, signal });
  }
}

async function loadDoublespeedPlatformRuntime(
  runtime: DoublespeedRuntimeImplementation,
  runtimeInstance: string,
  host: PlatformRuntimeHost,
): Promise<PlatformRuntimeOwner> {
  const { createDoublespeedPlatformRuntimeOwner } = await import('./app-log-runtime.ts');
  return createDoublespeedPlatformRuntimeOwner({
    host,
    runtimeInstance,
    ownsDevice: (device) => runtime.ownsDevice(device),
    hasLiveSession: (device) => runtime.hasLiveSession(device),
    getInteractor: (device, runner) => runtime.getInteractor(device, runner),
    openCurrent: async (device) => runtime.currentAppLogReader(device),
    reconnect: async (descriptor, signal) =>
      await runtime.reconnectAppLogReader(descriptor, signal),
    listApps: async (device, filter, signal) => {
      signal.throwIfAborted();
      const session = runtime.getDeviceSession(device);
      if (!session) {
        throw new AppError('DEVICE_NOT_FOUND', 'Doublespeed app inventory session is unavailable', {
          deviceId: device.id,
        });
      }
      return (await session.listApps(filter, signal)).map((app) => ({
        id: app.id,
        name: app.name ?? app.id,
      }));
    },
    getAppState: async (device, signal) => {
      signal.throwIfAborted();
      const session = runtime.getDeviceSession(device);
      if (!session) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Doublespeed appstate requires an active provider session',
        );
      }
      const state = await session.getForegroundApp(signal);
      signal.throwIfAborted();
      return { package: state.appId };
    },
    deployApp: async (device, input, signal) =>
      await runtime.installApp(
        device,
        input.app,
        input.appPath,
        { relaunch: input.replaceExisting, appIdentifierHint: input.app },
        signal,
      ),
    deployMaterializedApp: async (device, input, signal) =>
      await runtime.installInstallablePath(
        device,
        input.artifact.installablePath,
        { appIdentifierHint: input.artifact.bundleId },
        signal,
      ),
  });
}
