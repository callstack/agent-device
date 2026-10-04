import Limrun from '@limrun/api';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleProvider,
  LeaseLifecycleContext,
  ProviderAppCatalogHandler,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
  ProviderExpiredLeaseRecovery,
  ProviderPortReverseOptions,
} from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  cleanupLimrunAndroidAdbTunnel,
  configureLimrunAndroidPortReverse,
  createLimrunAndroidInteractor,
  createLimrunAndroidSession,
  installLimrunAndroidApp,
  type LimrunAndroidSession,
} from './android.ts';
import {
  attachedLimrunInstanceId,
  buildLimrunDevice,
  LIMRUN_PROVIDER,
  parseLimrunDeviceId,
  platformForLimrunLeaseBackend,
  type LimrunPlatform,
} from './device.ts';
import {
  createLimrunIosInteractor,
  createLimrunIosSession,
  installLimrunIosApp,
  type LimrunIosSession,
} from './ios.ts';
import { createLimrunDeviceSession, type LimrunDeviceSession } from './device-session.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { LimrunAppLogDescriptor } from './app-log-descriptor.ts';
import type { LimrunAppLogReader } from './app-log-poller.ts';
import {
  buildLimrunClientOptions,
  LIMRUN_CLIENT_HEADER,
  requireLimrunOrgClient,
} from './client-options.ts';
import { resolveLimrunRuntimeInstance } from './runtime-instance.ts';
import type { LimrunRequestOperationDrain } from './request-cancellation.ts';
import type { LimrunAppAsset } from './app-catalog.ts';
import type { LimrunInstanceAccess } from './instance-access.ts';

type LimrunRuntimeSession = LimrunIosSession | LimrunAndroidSession;

const KEEP_ALIVE_INTERVAL_MS = 30_000;

export type LimrunRuntimeOptions = {
  /** Organization API key. It creates and deletes instances for platforms without `instances`. */
  apiKey?: string;
  region?: string;
  /** Pings each leased instance every 30 s so Limrun's inactivity timeout does not end idle sessions. */
  keepAlive?: boolean;
  runtimeInstance?: string;
  instances?: LimrunInstanceAccess;
};

export type LimrunRuntime = ProviderDeviceRuntime & {
  recoverExpiredLease: ProviderExpiredLeaseRecovery;
  getDeviceSession(device: DeviceInfo): LimrunDeviceSession | undefined;
};

export type LimrunRuntimeRegistration = Readonly<{
  runtime: LimrunRuntime;
  platformModule: PlatformRuntimeProviderModule;
}>;

export function createLimrunRuntime(
  options: LimrunRuntimeOptions,
  dependencies: LimrunRuntimeDependencies,
  mode: Readonly<{ includePlatformModule: true }>,
): LimrunRuntimeRegistration;
export function createLimrunRuntime(
  options: LimrunRuntimeOptions,
  dependencies: LimrunRuntimeDependencies,
): LimrunRuntime;
export function createLimrunRuntime(
  options: LimrunRuntimeOptions,
  dependencies: LimrunRuntimeDependencies,
  mode?: Readonly<{ includePlatformModule: true }>,
): LimrunRuntime | LimrunRuntimeRegistration {
  const runtime = new LimrunRuntimeImplementation(options, dependencies);
  if (!mode?.includePlatformModule) return runtime;
  const owner = providerRuntimeOwner(LIMRUN_PROVIDER, resolveLimrunRuntimeInstance(options));
  if (owner.kind !== 'provider-runtime') throw new TypeError('Invalid Limrun runtime owner');
  return Object.freeze({
    runtime,
    platformModule: Object.freeze({
      owner,
      loadRuntime: async (host: PlatformRuntimeHost) =>
        await loadLimrunPlatformRuntime(runtime, owner.instance, host),
    }),
  });
}

class LimrunRuntimeImplementation implements ProviderDeviceRuntime {
  private readonly limrun: Limrun | undefined;
  private readonly sessions = new Map<string, LimrunRuntimeSession>();
  private readonly keepAliveTimers = new Map<string, NodeJS.Timeout>();
  private readonly appAliases = new Map<
    string,
    Readonly<{ assetName: string; installedAppId: string }>
  >();
  private readonly options: LimrunRuntimeOptions;
  private readonly dependencies: LimrunRuntimeDependencies;
  readonly provider = LIMRUN_PROVIDER;

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease, context) => await this.allocate(lease, context),
    release: async (lease) => await this.release(lease),
  };

  readonly appCatalog: ProviderAppCatalogHandler = async (query, signal) => {
    const { assertLimrunUploadedAppAccess, listLimrunAppAssets } = await import('./app-catalog.ts');
    assertLimrunUploadedAppAccess(query.publicNetworkOnly);
    const limrun = this.orgClient(
      'Listing uploaded apps',
      'Run open <bundle-or-package-id> first; apps then lists the apps installed on the instance.',
    );
    return (await listLimrunAppAssets(limrun, query.platform, signal)).map((asset) => asset.name);
  };

  readonly recoverExpiredLease: ProviderExpiredLeaseRecovery = async (lease) => {
    if (lease.leaseProvider !== this.provider || !platformForLimrunLeaseBackend(lease.backend)) {
      throw new AppError('UNSUPPORTED_OPERATION', 'Limrun cannot recover this expired lease.', {
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
    if (request.platform && request.platform !== session.platform) return [];
    return [session.device];
  };

  constructor(options: LimrunRuntimeOptions, dependencies: LimrunRuntimeDependencies) {
    if (!options.apiKey && !options.instances?.ios && !options.instances?.android) {
      throw new TypeError('Limrun runtime requires an apiKey or instance access');
    }
    this.options = options;
    this.dependencies = dependencies;
    this.limrun = options.apiKey
      ? new Limrun(
          buildLimrunClientOptions({
            apiKey: options.apiKey,
            clientVersion: dependencies.clientVersion,
          }),
        )
      : undefined;
  }

  ownsDevice(device: DeviceInfo): boolean {
    return parseLimrunDeviceId(device.id) !== undefined;
  }

  hasLiveSession(device: DeviceInfo): boolean {
    return this.getSessionForDevice(device) !== undefined;
  }

  getInteractor(device: DeviceInfo, _runner?: RunnerContext): Interactor | undefined {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    return session.platform === 'ios'
      ? createLimrunIosInteractor(session)
      : createLimrunAndroidInteractor(session);
  }

  getDeviceSession(device: DeviceInfo): LimrunDeviceSession | undefined {
    const session = this.getSessionForDevice(device);
    return session ? createLimrunDeviceSession(session) : undefined;
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
    signal?: AbortSignal,
    operationDrain?: LimrunRequestOperationDrain,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.installInstallablePath(
      device,
      appPath,
      {
        ...options,
        appIdentifierHint: options?.appIdentifierHint ?? app,
        packageNameHint: options?.packageNameHint ?? app,
      },
      signal,
      operationDrain,
    );
  }

  async installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
    signal?: AbortSignal,
    operationDrain?: LimrunRequestOperationDrain,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    const limrun = this.orgClient('Uploading an app');
    return session.platform === 'ios'
      ? await installLimrunIosApp(limrun, session, installablePath, options, signal, operationDrain)
      : await installLimrunAndroidApp(
          limrun,
          session,
          installablePath,
          options,
          signal,
          operationDrain,
        );
  }

  async configurePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    const session = this.requireAndroidPortReverseSession(options.leaseId);
    if (!session) return undefined;
    await configureLimrunAndroidPortReverse(session, options);
    return portReverseResult(options);
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map(async (session) => await this.terminateSession(session)));
    this.sessions.clear();
    this.appAliases.clear();
  }

  private async allocate(
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const platform = platformForLimrunLeaseBackend(lease.backend);
    if (!platform) return undefined;
    const existing = this.sessions.get(lease.leaseId);
    if (existing) return { limrunInstanceId: existing.instanceId, device: existing.device };

    const session =
      (await this.attachSession(platform, lease)) ??
      (await this.createSession(platform, lease, context));
    this.sessions.set(lease.leaseId, session);
    if (this.options.keepAlive) this.startKeepAlive(lease.leaseId, session);
    return { limrunInstanceId: session.instanceId, device: session.device };
  }

  private async attachSession(
    platform: LimrunPlatform,
    lease: DeviceLease,
  ): Promise<LimrunRuntimeSession | undefined> {
    const { ios, android } = this.options.instances ?? {};
    const target = (apiUrl: string) => {
      const instanceId = attachedLimrunInstanceId(apiUrl);
      const device = buildLimrunDevice(platform, lease, instanceId);
      return { lease, instanceId, ownership: 'attached' as const, device };
    };
    if (platform === 'android') {
      return (
        android &&
        (await createLimrunAndroidSession(
          { ...target(android.apiUrl), ...android },
          this.dependencies,
        ))
      );
    }
    return (
      ios && (await createLimrunIosSession({ ...target(ios.apiUrl), ...ios }, this.dependencies))
    );
  }

  private async createSession(
    platform: LimrunPlatform,
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ): Promise<LimrunRuntimeSession> {
    const {
      allocateLimrunAndroidSession,
      allocateLimrunIosSession,
      resolvePreinstalledAppId,
      resolveRequestedLimrunAppAsset,
    } = await import('./session-allocation.ts');
    const limrun = this.orgClient('Creating an instance');
    const requestedAsset = await resolveRequestedLimrunAppAsset(limrun, platform, context);
    const params = this.sessionAllocationParams(limrun, lease, requestedAsset);
    const session =
      platform === 'ios'
        ? await allocateLimrunIosSession(params)
        : await allocateLimrunAndroidSession(params);
    if (requestedAsset) {
      try {
        const installedAppId = await resolvePreinstalledAppId(session, requestedAsset);
        this.appAliases.set(lease.leaseId, {
          assetName: requestedAsset.name,
          installedAppId,
        });
      } catch (error) {
        await this.terminateSession(session);
        throw error;
      }
    }
    return session;
  }

  private sessionAllocationParams(limrun: Limrun, lease: DeviceLease, app?: LimrunAppAsset) {
    return {
      limrun,
      lease,
      metadata: this.buildInstanceMetadata(lease),
      region: this.options.region,
      app,
      dependencies: this.dependencies,
    };
  }

  private buildInstanceMetadata(lease: DeviceLease) {
    return {
      displayName: `agent-device-${lease.tenantId}-${lease.runId}`,
      labels: {
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseId: lease.leaseId,
        provider: lease.leaseProvider ?? LIMRUN_PROVIDER,
        source: LIMRUN_CLIENT_HEADER,
      },
    };
  }

  private async release(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    const session = this.sessions.get(lease.leaseId);
    if (!session) return await this.releaseRecoveredSession(lease);
    await this.terminateSession(session);
    this.sessions.delete(lease.leaseId);
    this.appAliases.delete(lease.leaseId);
    return { limrunInstanceId: session.instanceId };
  }

  private async releaseRecoveredSession(
    lease: DeviceLease,
  ): Promise<Record<string, unknown> | undefined> {
    const platform = platformForLimrunLeaseBackend(lease.backend);
    const limrun = this.limrun;
    if (!platform || !limrun) return undefined;
    const labelSelector = `provider=${LIMRUN_PROVIDER},leaseId=${lease.leaseId}`;
    const instances =
      platform === 'ios'
        ? await limrun.iosInstances.list({ labelSelector })
        : await limrun.androidInstances.list({ labelSelector });
    const instanceIds = instances.getPaginatedItems().map((instance) => instance.metadata.id);
    for (const instanceId of instanceIds) {
      if (platform === 'ios') {
        await limrun.iosInstances.delete(instanceId);
      } else {
        await limrun.androidInstances.delete(instanceId);
      }
    }
    if (instanceIds.length === 0) return undefined;
    return { limrunInstanceId: instanceIds[0], limrunInstanceCount: instanceIds.length };
  }

  private startKeepAlive(leaseId: string, session: LimrunRuntimeSession): void {
    const timer = setInterval(() => {
      try {
        session.client.keepAlive();
      } catch {
        // A dead connection surfaces on the next real command.
      }
    }, KEEP_ALIVE_INTERVAL_MS);
    timer.unref();
    this.keepAliveTimers.set(leaseId, timer);
  }

  private async terminateSession(session: LimrunRuntimeSession): Promise<void> {
    const leaseId = session.lease.leaseId;
    clearInterval(this.keepAliveTimers.get(leaseId));
    this.keepAliveTimers.delete(leaseId);
    session.client.disconnect();
    if (session.platform === 'android') await cleanupLimrunAndroidAdbTunnel(session);
    if (session.ownership === 'attached') return;
    const limrun = this.orgClient('Deleting an instance');
    if (session.platform === 'ios') {
      await limrun.iosInstances.delete(session.instanceId);
    } else {
      await limrun.androidInstances.delete(session.instanceId);
    }
  }

  private orgClient(operation: string, hint?: string): Limrun {
    return requireLimrunOrgClient(this.limrun, operation, hint);
  }

  private getSessionForDevice(device: DeviceInfo): LimrunRuntimeSession | undefined {
    const parsed = parseLimrunDeviceId(device.id);
    if (!parsed) return undefined;
    const session = this.sessions.get(parsed.leaseId);
    return session?.platform === parsed.platform ? session : undefined;
  }

  resolveAppReference(device: DeviceInfo, app: string): string {
    const parsed = parseLimrunDeviceId(device.id);
    if (!parsed) return app;
    const alias = this.appAliases.get(parsed.leaseId);
    return alias?.assetName === app ? alias.installedAppId : app;
  }

  currentAppLogReader(device: DeviceInfo): LimrunAppLogReader | undefined {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    const publicSession = createLimrunDeviceSession(session);
    return {
      platform: session.platform,
      leaseId: session.lease.leaseId,
      instanceId: session.instanceId,
      ownership: session.ownership,
      readLogs: async (appBundleId, lineLimit) =>
        publicSession.platform === 'ios'
          ? await publicSession.readLogs(appBundleId, lineLimit)
          : await publicSession.readLogs(lineLimit),
      [Symbol.asyncDispose]: async () => undefined,
    };
  }

  async reconnectAppLogReader(descriptor: LimrunAppLogDescriptor, signal?: AbortSignal) {
    const { reconnectLimrunAppLogReader } = await import('./app-log-reconnect.ts');
    return await reconnectLimrunAppLogReader({
      limrun: this.limrun,
      instances: this.options.instances,
      descriptor,
      dependencies: this.dependencies,
      signal,
    });
  }

  private requireAndroidPortReverseSession(leaseId: string): LimrunAndroidSession | undefined {
    const session = this.sessions.get(leaseId);
    if (!session || session.platform === 'android') return session;
    throw unsupported(
      'port reverse',
      'Direct Limrun iOS sessions cannot reach local host ports; use a bridge public URL.',
    );
  }
}

async function loadLimrunPlatformRuntime(
  runtime: LimrunRuntimeImplementation,
  runtimeInstance: string,
  host: PlatformRuntimeHost,
): Promise<PlatformRuntimeOwner> {
  const { createLimrunPlatformRuntimeOwner } = await import('./app-log-runtime.ts');
  return createLimrunPlatformRuntimeOwner({
    host,
    runtimeInstance,
    ownsDevice: (device) => runtime.ownsDevice(device),
    hasLiveSession: (device) => runtime.hasLiveSession(device),
    getInteractor: (device, runner) => runtime.getInteractor(device, runner),
    getDeviceSession: (device) => runtime.getDeviceSession(device),
    resolveAppReference: (device, app) => runtime.resolveAppReference(device, app),
    openCurrent: async (device) => runtime.currentAppLogReader(device),
    reconnect: async (descriptor, signal) =>
      await runtime.reconnectAppLogReader(descriptor, signal),
    listApps: async (device, filter, signal) => {
      signal.throwIfAborted();
      const session = runtime.getDeviceSession(device);
      if (!session) {
        throw new AppError('DEVICE_NOT_FOUND', 'Limrun app inventory session is unavailable', {
          deviceId: device.id,
        });
      }
      return (await session.listApps(filter)).map((app) => ({
        id: app.id,
        name: app.name ?? app.id,
      }));
    },
    getAppState: async (device, signal) => {
      signal.throwIfAborted();
      const session = runtime.getDeviceSession(device);
      if (session?.platform !== 'android') {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Limrun Android appstate requires an active provider session',
        );
      }
      const state = await session.getForegroundApp(signal);
      signal.throwIfAborted();
      return { package: state?.appId, activity: state?.activity };
    },
    deployApp: async (device, input, signal, operationDrain) =>
      await runtime.installApp(
        device,
        input.app,
        input.appPath,
        {
          relaunch: input.replaceExisting,
          appIdentifierHint: input.app,
          packageNameHint: input.app,
        },
        signal,
        operationDrain,
      ),
    deployMaterializedApp: async (device, input, signal, operationDrain) =>
      await runtime.installInstallablePath(
        device,
        input.artifact.installablePath,
        {
          appIdentifierHint: input.artifact.bundleId,
          packageNameHint: input.artifact.packageName,
        },
        signal,
        operationDrain,
      ),
    configurePortReverse: async (options) => await runtime.configurePortReverse(options),
  });
}

function portReverseResult(options: ProviderPortReverseOptions): Record<string, unknown> {
  return {
    leaseId: options.leaseId,
    devicePort: options.devicePort,
    hostPort: options.hostPort,
    name: options.name,
  };
}

function unsupported(command: string, message: string): never {
  throw new AppError('UNSUPPORTED_OPERATION', message, { command });
}
