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
import type {
  ProviderLeaseFailureReason,
  ProviderLeaseRejection,
  ProviderLeaseSearch,
  ProviderLeaseSessionTable,
  ProviderLeaseStartControl,
  ProviderLeaseStopOutcome,
} from '@agent-device/capture-kit/provider-lease-sessions';
import type { LimrunAppLogDescriptor } from './app-log-descriptor.ts';
import type { LimrunAppLogReader } from './app-log-runtime.ts';
import { LIMRUN_CLIENT_ID, limrunUserAgent, requireLimrunOrgClient } from './client-options.ts';
import { resolveLimrunRuntimeInstance } from './runtime-instance.ts';
import type { LimrunRequestOperationDrain } from './request-cancellation.ts';
import type { LimrunAppAsset } from './app-catalog.ts';
import type { LimrunInstanceAccess } from './instance-access.ts';
import type {
  CloudArtifactProvider,
  CloudArtifactsQuery,
  CloudArtifactsResult,
} from '@agent-device/contracts/observability';
import type {
  LimrunHarCapture,
  LimrunHarCaptureFailure,
  LimrunTunnelFailureReport,
} from './network-har.ts';
import path from 'node:path';

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
  /**
   * Where `--provider-network-logs` writes each session's live HAR file. The composition root
   * resolves it under the daemon state dir; without it the opt-in reports a typed refusal.
   */
  networkHarDir?: string;
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
  private readonly keepAliveTimers = new Map<string, NodeJS.Timeout>();
  /** Each lease's `--provider-network-logs` capture: live, stopped at release, or never started. */
  private readonly networkCaptures = new Map<string, NetworkCaptureState>();
  private readonly appAliases = new Map<
    string,
    Readonly<{ assetName: string; installedAppId: string }>
  >();
  private readonly options: LimrunRuntimeOptions;
  private readonly dependencies: LimrunRuntimeDependencies;
  readonly provider = LIMRUN_PROVIDER;

  /**
   * Which lease ids this runtime serves, and what releasing each one amounts to. Built on the first
   * lease call: this module is reached from the package entry the daemon evaluates at boot, so the
   * table's module stays off that path.
   */
  private leaseTable?: ProviderLeaseSessionTable<LimrunRuntimeSession, LimrunLeaseRequest>;
  private leaseTableLoad?: Promise<void>;

  private sessionsTable(): Promise<
    ProviderLeaseSessionTable<LimrunRuntimeSession, LimrunLeaseRequest>
  > {
    this.leaseTableLoad ??= import('@agent-device/capture-kit/provider-lease-sessions').then(
      ({ createProviderLeaseSessionTable }) => {
        this.leaseTable = createProviderLeaseSessionTable<
          LimrunRuntimeSession,
          LimrunInstanceSearch,
          LimrunLeaseRequest
        >(this.leaseSessionDriver());
      },
    );
    return this.leaseTableLoad.then(() => this.leaseTable!);
  }

  /**
   * The session this process holds for a lease id. `undefined` before the first lease call, when no
   * table exists and nothing was rented.
   */
  private heldSession(leaseId: string): LimrunRuntimeSession | undefined {
    return this.leaseTable?.find(leaseId);
  }

  private leaseSessionDriver() {
    return {
      prepare: async (request: LimrunLeaseRequest) => {
        const { rejectRefusedLimrunProfileFields } = await import('./session-allocation.ts');
        // Ahead of the reuse the table may answer with, since a repeat allocation carries flags of
        // its own, and ahead of attach as well as create, since an attached instance reads neither.
        rejectRefusedLimrunProfileFields(request.context);
      },
      start: async (
        request: LimrunLeaseRequest,
        control: ProviderLeaseStartControl<LimrunRuntimeSession>,
      ) => {
        const { lease, context } = request;
        const platform = requireLimrunLeasePlatform(lease);
        const session =
          (await this.attachSession(platform, lease)) ??
          (await this.createSession(platform, lease, context));
        control.adopt(session);
        if (this.options.keepAlive) this.startKeepAlive(lease.leaseId, session);
        const networkHar =
          context?.flags?.providerNetworkLogs === true
            ? await this.startNetworkCapture(lease, session, context)
            : undefined;
        return {
          limrunInstanceId: session.instanceId,
          providerSessionId: session.instanceId,
          device: session.device,
          ...(networkHar ? { networkHar } : {}),
        };
      },
      reuse: async (session: LimrunRuntimeSession, request: LimrunLeaseRequest) => {
        // A repeat allocation can opt into the capture the first one did not ask for, or retry one
        // that could not start.
        const networkHar =
          request.context?.flags?.providerNetworkLogs === true &&
          (this.networkCaptures.get(request.lease.leaseId)?.phase ?? 'unavailable') ===
            'unavailable'
            ? await this.startNetworkCapture(request.lease, session, request.context)
            : undefined;
        return {
          limrunInstanceId: session.instanceId,
          device: session.device,
          ...(networkHar ? { networkHar } : {}),
        };
      },
      describeRelease: async (session: LimrunRuntimeSession) => {
        const networkCapture = await this.stopNetworkCapture(session.lease.leaseId);
        return {
          limrunInstanceId: session.instanceId,
          providerSessionId: session.instanceId,
          ...(networkCapture ? { cloudArtifacts: networkCaptureArtifacts(networkCapture) } : {}),
        };
      },
      stop: async (session: LimrunRuntimeSession) => {
        await this.terminateSession(session);
        this.appAliases.delete(session.lease.leaseId);
      },
      searchLease: async (request: LimrunLeaseRequest) =>
        await this.searchLimrunInstances(request.lease),
      stopLease: async (found: LimrunInstanceSearch) => await this.deleteLimrunInstances(found),
      reject: (rejection: ProviderLeaseRejection, reason: ProviderLeaseFailureReason) =>
        limrunLeaseError(rejection, reason),
    };
  }

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    // A lease another provider owns, or a backend Limrun has no instance for, is not this runtime's
    // to allocate; the daemon reads `undefined` as "nothing to do".
    allocate: async (lease, context) => {
      if (limrunLeasePlatform(lease) === undefined) return undefined;
      const table = await this.sessionsTable();
      return await table.allocate({ lease, context }, lease.leaseId, {
        signal: context?.signal,
        deadlineAt: context?.deadline,
      });
    },
    release: async (lease) => {
      const table = await this.sessionsTable();
      return await table.release({ lease }, lease.leaseId);
    },
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
    // The daemon drops a pending release once recovery resolves, so an unconfirmed stop has to keep
    // the lease pending rather than report a device Limrun may still be holding.
    const table = await this.sessionsTable();
    await table.release({ lease }, lease.leaseId);
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider || !request.leaseId) return null;
    const session = this.heldSession(request.leaseId);
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
      ? new Limrun({
          apiKey: options.apiKey,
          userAgent: limrunUserAgent(dependencies.clientVersion),
        })
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
    try {
      const table = await this.sessionsTable();
      await table.shutdown();
    } finally {
      this.appAliases.clear();
    }
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
        source: LIMRUN_CLIENT_ID,
      },
    };
  }

  /**
   * The Limrun instances labelled for one lease. This process may not have started them: the daemon
   * restarts, and the persisted lease is the only handle left.
   */
  private async searchLimrunInstances(
    lease: DeviceLease,
  ): Promise<ProviderLeaseSearch<LimrunInstanceSearch>> {
    const platform = platformForLimrunLeaseBackend(lease.backend);
    const limrun = this.limrun;
    if (!platform || !limrun) return { status: 'absent' };
    const labelSelector = `provider=${LIMRUN_PROVIDER},leaseId=${lease.leaseId}`;
    try {
      const instances =
        platform === 'ios'
          ? await limrun.iosInstances.list({ labelSelector })
          : await limrun.androidInstances.list({ labelSelector });
      return {
        status: 'found',
        lease: { platform, instanceIds: instances.getPaginatedItems().map((i) => i.metadata.id) },
      };
    } catch (error) {
      // Reporting `absent` here would let the lease expire with its instance still rented.
      return { status: 'unknown', cause: error };
    }
  }

  private async deleteLimrunInstances(
    found: LimrunInstanceSearch,
  ): Promise<ProviderLeaseStopOutcome> {
    const limrun = this.orgClient('Deleting an instance');
    const deletions = await Promise.allSettled(
      found.instanceIds.map(async (instanceId) =>
        found.platform === 'ios'
          ? await limrun.iosInstances.delete(instanceId)
          : await limrun.androidInstances.delete(instanceId),
      ),
    );
    const failure = deletions.find((outcome) => outcome.status === 'rejected');
    if (failure && failure.status === 'rejected') {
      return { stopped: false, cause: failure.reason };
    }
    const [firstInstanceId] = found.instanceIds;
    return {
      stopped: true,
      ...(found.instanceIds.length === 0
        ? {}
        : {
            artifacts: {
              limrunInstanceId: firstInstanceId,
              limrunInstanceCount: found.instanceIds.length,
            },
          }),
    };
  }

  /**
   * `--provider-network-logs`: opens the instance's one destination tunnel with inspection and
   * keeps a live HAR file under the state dir. The Metro/companion route rides this tunnel.
   */
  private async startNetworkCapture(
    lease: DeviceLease,
    session: LimrunRuntimeSession,
    context?: LeaseLifecycleContext,
  ): Promise<Record<string, unknown>> {
    const instanceId = session.instanceId;
    const harDir = this.options.networkHarDir;
    const result = harDir
      ? await import('./network-har.ts').then(({ startLimrunHarCapture }) =>
          startLimrunHarCapture(session.client, {
            // One file per lease: an attached instance serves many sessions.
            harPath: path.join(harDir, `${instanceId}-${fileSafe(lease.leaseId)}.har`),
            selectors: readProviderNetworkHosts(context?.flags?.providerNetworkHosts),
          }),
        )
      : ({
          ok: false,
          reason: 'capture-dir-unset',
          message: 'The runtime has no directory for network capture files.',
        } as const);
    await this.forgetStoppedNetworkCaptures();
    if (!result.ok) {
      const { reason, message } = result;
      this.networkCaptures.set(lease.leaseId, {
        phase: 'unavailable',
        instanceId,
        reason,
        message,
      });
      return { status: 'unavailable', reason, message };
    }
    this.networkCaptures.set(lease.leaseId, {
      phase: 'capturing',
      instanceId,
      capture: result.capture,
    });
    return { status: 'capturing', harPath: result.capture.harPath };
  }

  private async stopNetworkCapture(leaseId: string): Promise<SettledNetworkCapture | undefined> {
    const state = this.networkCaptures.get(leaseId);
    if (state?.phase !== 'capturing') return state;
    // Read the tunnel's last dial failure while the tunnel is still open.
    const failures = await state.capture.failures();
    await state.capture.close();
    const stopped = {
      phase: 'stopped',
      instanceId: state.instanceId,
      harPath: state.capture.harPath,
      failures,
    } as const;
    this.networkCaptures.set(leaseId, stopped);
    return stopped;
  }

  /** Keeps released captures listable for a while without growing for the daemon's lifetime. */
  private async forgetStoppedNetworkCaptures(): Promise<void> {
    const settled = [...this.networkCaptures].filter(([, state]) => state.phase !== 'capturing');
    const { discardLimrunHar } = await import('./network-har.ts');
    for (const [leaseId, state] of settled.slice(0, -SETTLED_NETWORK_CAPTURE_LIMIT)) {
      this.networkCaptures.delete(leaseId);
      // The file holds raw traffic, so it lives exactly as long as the record that reports it.
      if (state.phase === 'stopped') await discardLimrunHar(state.harPath).catch(() => undefined);
    }
  }

  readonly cloudArtifacts: CloudArtifactProvider = {
    listCloudArtifacts: async (
      query: CloudArtifactsQuery,
    ): Promise<CloudArtifactsResult | undefined> => {
      const state = query.leaseId ? this.networkCaptures.get(query.leaseId) : undefined;
      if (state?.phase !== 'capturing') return state ? networkCaptureArtifacts(state) : undefined;
      return networkCaptureArtifacts({
        phase: 'stopped',
        instanceId: state.instanceId,
        harPath: state.capture.harPath,
        failures: await state.capture.failures(),
      });
    },
  };

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
    // A capture rides the instance's one tunnel; close it before the client disconnects.
    const networkCapture = this.networkCaptures.get(leaseId);
    if (networkCapture?.phase === 'capturing') {
      this.networkCaptures.delete(leaseId);
      // The client disconnect below ends the tunnel even when its own close fails.
      await networkCapture.capture.close().catch(() => undefined);
    }
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
    const session = this.heldSession(parsed.leaseId);
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
    const session = this.heldSession(leaseId);
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

function fileSafe(value: string): string {
  return value.replaceAll(/[^\w.-]/g, '_');
}

/** The `--provider-network-hosts` comma list, or undefined to keep the default selectors. */
function readProviderNetworkHosts(value: unknown): readonly string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const hosts = value
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

const SETTLED_NETWORK_CAPTURE_LIMIT = 32;

/** One Limrun allocation or release: the lease the daemon named, plus an allocation's context. */
type LimrunLeaseRequest = Readonly<{ lease: DeviceLease; context?: LeaseLifecycleContext }>;

/** The Limrun instances labelled for one lease, which this process need not have started. */
type LimrunInstanceSearch = Readonly<{
  platform: LimrunPlatform;
  instanceIds: readonly string[];
}>;

/** The platform Limrun rents for a lease, or `undefined` when the lease is not this runtime's. */
function limrunLeasePlatform(lease: DeviceLease): LimrunPlatform | undefined {
  return lease.leaseProvider === LIMRUN_PROVIDER
    ? platformForLimrunLeaseBackend(lease.backend)
    : undefined;
}

function requireLimrunLeasePlatform(lease: DeviceLease): LimrunPlatform {
  const platform = limrunLeasePlatform(lease);
  if (!platform) {
    throw new AppError('UNSUPPORTED_OPERATION', 'Limrun cannot serve this lease.', {
      leaseId: lease.leaseId,
      leaseProvider: lease.leaseProvider,
      leaseBackend: lease.backend,
    });
  }
  return platform;
}

/**
 * Reports a lease-table failure. A stop or search that did not answer leaves the device rented, so
 * it says cleanup is pending and keeps the provider's failure as the cause; a caller retrying the
 * release reads that cause to tell a temporary refusal from a real end.
 */
function limrunLeaseError(
  rejection: ProviderLeaseRejection,
  reason: ProviderLeaseFailureReason,
): AppError {
  const cause = 'cause' in rejection ? rejection.cause : undefined;
  const details: Record<string, unknown> = {
    reason,
    leaseId: 'leaseId' in rejection ? rejection.leaseId : undefined,
  };
  let message: string;
  switch (rejection.reason) {
    case 'provider-runtime-shutting-down':
      message = 'Limrun is shutting down and takes no new lease work.';
      break;
    case 'provider-allocation-cancelled':
      message =
        `Limrun stopped the instance it rented for lease '${rejection.leaseId}' ` +
        'because the request was cancelled.';
      break;
    case 'provider-start-deadline-exceeded':
      message = `Limrun could not allocate the session for lease '${rejection.leaseId}' before its deadline.`;
      details.deadlineAt = rejection.deadlineAt;
      break;
    case 'provider-stop-unconfirmed':
      message = `Limrun could not stop the instance for lease '${rejection.leaseId}': ${errorText(cause)}`;
      break;
    case 'provider-drain-unconfirmed':
      message =
        `Limrun could not stop the instances for leases ` +
        `'${rejection.leaseIds.join("', '")}' while shutting down.`;
      details.leaseIds = rejection.leaseIds;
      break;
    case 'provider-lease-search-unanswered':
      message =
        `Limrun could not look up the instances for lease '${rejection.leaseId}': ` +
        `${errorText(cause)}`;
      break;
    case 'provider-lease-not-releasable':
      message =
        `Limrun found instances for lease '${rejection.leaseId}' it cannot stop, ` +
        'so they stay rented.';
      break;
  }
  return new AppError(
    'COMMAND_FAILED',
    `Limrun lease operation did not complete: ${message}`,
    details,
    cause,
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SettledNetworkCapture =
  | Readonly<{
      phase: 'stopped';
      instanceId: string;
      harPath: string;
      failures: LimrunTunnelFailureReport;
    }>
  | Readonly<{ phase: 'unavailable'; instanceId: string } & LimrunHarCaptureFailure>;

type NetworkCaptureState =
  | SettledNetworkCapture
  | Readonly<{ phase: 'capturing'; instanceId: string; capture: LimrunHarCapture }>;

const NETWORK_ARTIFACT_NAME = 'Network traffic (HAR, live file on the daemon host)';

/**
 * One HAR file, stated as a provider artifact whose `url` is its path on this host. The tunnel
 * failure report rides the artifact's metadata, and its summary is the result's message. A capture
 * that never started is an unavailable artifact carrying the typed reason.
 */
function networkCaptureArtifacts(capture: SettledNetworkCapture): CloudArtifactsResult {
  if (capture.phase === 'unavailable') {
    return {
      provider: LIMRUN_PROVIDER,
      status: 'unavailable',
      providerSessionId: capture.instanceId,
      message: `Network capture did not start (${capture.reason}): ${capture.message}`,
      cloudArtifacts: [
        {
          provider: LIMRUN_PROVIDER,
          kind: 'network',
          name: NETWORK_ARTIFACT_NAME,
          availability: 'unavailable',
          metadata: { reason: capture.reason },
        },
      ],
    };
  }
  const { harPath, instanceId, failures } = capture;
  return {
    provider: LIMRUN_PROVIDER,
    status: 'ready',
    providerSessionId: instanceId,
    ...(failures.total > 0 || failures.lastDialFailure
      ? { message: summarizeTunnelFailures(failures) }
      : {}),
    cloudArtifacts: [
      {
        provider: LIMRUN_PROVIDER,
        kind: 'network',
        name: NETWORK_ARTIFACT_NAME,
        url: harPath,
        extension: 'har',
        contentType: 'application/json',
        availability: 'ready',
        metadata: { tunnelFailures: failures },
      },
    ],
  };
}

function summarizeTunnelFailures(failures: LimrunTunnelFailureReport): string {
  const kinds = Object.entries(failures.byKind).map(([kind, entry]) => {
    const failure = entry.latest.at(-1);
    const endpoint = failure?.host
      ? ` ${failure.host}${failure.port ? `:${failure.port}` : ''}`
      : '';
    return `${kind} ${entry.count}, latest${endpoint} (${failure?.message})`;
  });
  const dial = failures.lastDialFailure
    ? [`last dial failure ${failures.lastDialFailure.reason}`]
    : [];
  return `Network capture failures: ${failures.total}; ${[...kinds, ...dial].join('; ')}`;
}
