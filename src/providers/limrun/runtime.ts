import Limrun from '@limrun/api';
import type { Interactor } from '../../core/interactor-types.ts';
import type { DeviceInventoryProvider } from '../../core/dispatch-resolve.ts';
import type { LeaseLifecycleProvider } from '../../daemon/handlers/lease.ts';
import type { DeviceLease } from '../../daemon/lease-registry.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
import type {
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
  ProviderExpiredLeaseRecovery,
  ProviderPortReverseOptions,
} from '../../provider-device-runtime.ts';
import { readVersion } from '../../utils/version.ts';
import {
  cleanupLimrunAndroidAdbTunnel,
  configureLimrunAndroidPortReverse,
  createLimrunAndroidInteractor,
  createLimrunAndroidSession,
  installLimrunAndroidApp,
  type LimrunAndroidSession,
} from './android.ts';
import {
  buildLimrunDevice,
  LIMRUN_PROVIDER,
  parseLimrunDeviceId,
  platformForLimrunLeaseBackend,
} from './device.ts';
import {
  createLimrunIosInteractor,
  createLimrunIosSession,
  installLimrunIosApp,
  type LimrunIosSession,
} from './ios.ts';

type LimrunInstance = {
  metadata: { id: string };
  status: {
    token: string;
    apiUrl?: string;
    adbWebSocketUrl?: string;
  };
};

type LimrunRuntimeSession = LimrunIosSession | LimrunAndroidSession;

type LimrunRuntimeOptions = {
  apiKey: string;
  region?: string;
  version?: string;
};

const LIMRUN_CLIENT_HEADER = 'agent-device-cli';

export function createLimrunRuntimeFromEnv(env: NodeJS.ProcessEnv): LimrunRuntime | undefined {
  const apiKey = env.LIMRUN_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new LimrunRuntime({
    apiKey,
    region: env.LIMRUN_REGION?.trim() || undefined,
    version: readVersion(),
  });
}

export class LimrunRuntime implements ProviderDeviceRuntime {
  private readonly limrun: Limrun;
  private readonly sessions = new Map<string, LimrunRuntimeSession>();
  private readonly options: LimrunRuntimeOptions;
  readonly provider = LIMRUN_PROVIDER;

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease) => await this.allocate(lease),
    release: async (lease) => await this.release(lease),
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

  constructor(options: LimrunRuntimeOptions) {
    this.options = options;
    this.limrun = new Limrun({
      apiKey: options.apiKey,
      defaultHeaders: {
        'x-agent-device-client': LIMRUN_CLIENT_HEADER,
        'x-agent-device-version': options.version ?? readVersion(),
      },
    });
  }

  ownsDevice(device: DeviceInfo): boolean {
    return parseLimrunDeviceId(device.id) !== undefined;
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    return session.platform === 'ios'
      ? createLimrunIosInteractor(session)
      : createLimrunAndroidInteractor(session);
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.installInstallablePath(device, appPath, {
      ...options,
      appIdentifierHint: options?.appIdentifierHint ?? app,
      packageNameHint: options?.packageNameHint ?? app,
    });
  }

  async installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    return session.platform === 'ios'
      ? await installLimrunIosApp(this.limrun, session, installablePath, options)
      : await installLimrunAndroidApp(this.limrun, session, installablePath, options);
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
  }

  private async allocate(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const platform = platformForLimrunLeaseBackend(lease.backend);
    if (!platform) return undefined;
    const existing = this.sessions.get(lease.leaseId);
    if (existing) return { limrunInstanceId: existing.instanceId, device: existing.device };

    const session =
      platform === 'ios'
        ? await this.createIosSession(lease)
        : await this.createAndroidSession(lease);
    this.sessions.set(lease.leaseId, session);
    return { limrunInstanceId: session.instanceId, device: session.device };
  }

  private async createIosSession(lease: DeviceLease): Promise<LimrunIosSession> {
    const instance = (await this.limrun.iosInstances.create({
      wait: true,
      metadata: this.buildInstanceMetadata(lease),
      spec: this.options.region ? { region: this.options.region } : {},
    })) as LimrunInstance;
    try {
      if (!instance.status.apiUrl) {
        throw new AppError('COMMAND_FAILED', 'Limrun iOS instance did not expose apiUrl');
      }
      return await createLimrunIosSession({
        lease,
        instanceId: instance.metadata.id,
        device: buildLimrunDevice('ios', lease, instance.metadata.id),
        apiUrl: instance.status.apiUrl,
        token: instance.status.token,
      });
    } catch (error) {
      await this.limrun.iosInstances.delete(instance.metadata.id).catch(() => {});
      throw error;
    }
  }

  private async createAndroidSession(lease: DeviceLease): Promise<LimrunAndroidSession> {
    const instance = (await this.limrun.androidInstances.create({
      wait: true,
      metadata: this.buildInstanceMetadata(lease),
      spec: this.options.region ? { region: this.options.region } : {},
    })) as LimrunInstance;
    try {
      if (!instance.status.apiUrl || !instance.status.adbWebSocketUrl) {
        throw new AppError(
          'COMMAND_FAILED',
          'Limrun Android instance did not expose API and ADB websocket endpoints',
        );
      }
      return await createLimrunAndroidSession({
        lease,
        instanceId: instance.metadata.id,
        device: buildLimrunDevice('android', lease, instance.metadata.id),
        apiUrl: instance.status.apiUrl,
        adbUrl: instance.status.adbWebSocketUrl,
        token: instance.status.token,
      });
    } catch (error) {
      await this.limrun.androidInstances.delete(instance.metadata.id).catch(() => {});
      throw error;
    }
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
    return { limrunInstanceId: session.instanceId };
  }

  private async releaseRecoveredSession(
    lease: DeviceLease,
  ): Promise<Record<string, unknown> | undefined> {
    const platform = platformForLimrunLeaseBackend(lease.backend);
    if (!platform) return undefined;
    const labelSelector = `provider=${LIMRUN_PROVIDER},leaseId=${lease.leaseId}`;
    const instances =
      platform === 'ios'
        ? await this.limrun.iosInstances.list({ labelSelector })
        : await this.limrun.androidInstances.list({ labelSelector });
    const instanceIds = instances.getPaginatedItems().map((instance) => instance.metadata.id);
    for (const instanceId of instanceIds) {
      if (platform === 'ios') {
        await this.limrun.iosInstances.delete(instanceId);
      } else {
        await this.limrun.androidInstances.delete(instanceId);
      }
    }
    if (instanceIds.length === 0) return undefined;
    return { limrunInstanceId: instanceIds[0], limrunInstanceCount: instanceIds.length };
  }

  private async terminateSession(session: LimrunRuntimeSession): Promise<void> {
    session.client.disconnect();
    if (session.platform === 'ios') {
      await this.limrun.iosInstances.delete(session.instanceId);
      return;
    }
    await cleanupLimrunAndroidAdbTunnel(session);
    await this.limrun.androidInstances.delete(session.instanceId);
  }

  private getSessionForDevice(device: DeviceInfo): LimrunRuntimeSession | undefined {
    const parsed = parseLimrunDeviceId(device.id);
    if (!parsed) return undefined;
    const session = this.sessions.get(parsed.leaseId);
    return session?.platform === parsed.platform ? session : undefined;
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
