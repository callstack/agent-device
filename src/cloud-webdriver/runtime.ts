import type {
  CloudArtifactProvider,
  CloudArtifactsQuery,
  CloudArtifactsResult,
} from '../cloud-artifacts.ts';
import type { DeviceInventoryProvider } from '../core/dispatch-resolve.ts';
import type { Interactor } from '../core/interactor-types.ts';
import type { LeaseLifecycleProvider } from '../daemon/handlers/lease.ts';
import type { DeviceLease } from '../daemon/lease-registry.ts';
import type {
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
} from '../provider-device-runtime.ts';
import type { DeviceInfo, Platform } from '../kernel/device.ts';
import { AppError } from '../kernel/errors.ts';
import {
  capabilitySupported,
  createCloudWebDriverCapabilities,
  unsupportedCapabilityMessage,
  type CloudWebDriverCapabilityOverrides,
  type CloudWebDriverProviderCapabilities,
} from './capabilities.ts';
import { providerInstallResult, snapshotBackendForPlatform } from './runtime-helpers.ts';
import {
  WebDriverClient,
  type WebDriverAuth,
  type WebDriverRequestPolicy,
} from './webdriver-client.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';

export type CloudWebDriverPlatform = Extract<Platform, 'android' | 'ios'>;

export type CloudWebDriverUploadResult = ProviderDeviceInstallResult & {
  appReference: string;
};

export type CloudWebDriverUploadApp = (params: {
  provider: string;
  lease: DeviceLease;
  device: DeviceInfo;
  app: string;
  appPath: string;
  options?: ProviderDeviceInstallOptions;
}) => Promise<CloudWebDriverUploadResult>;

export type CloudWebDriverBaseSession = {
  provider: string;
  endpoint: string | URL;
  platform: CloudWebDriverPlatform;
  deviceName: string;
  webdriverCapabilities: Record<string, unknown>;
  auth?: WebDriverAuth;
  headers?: Record<string, string>;
};

export type CloudWebDriverPreparedSession = CloudWebDriverBaseSession & {
  deviceId?: string;
  providerSessionId?: string;
  uploadApp?: CloudWebDriverUploadApp;
  listArtifacts?: CloudWebDriverListArtifacts;
  cleanup?: () => Promise<Record<string, unknown> | undefined>;
  providerData?: Record<string, unknown>;
};

export type CloudWebDriverListArtifacts = (params: {
  provider: string;
  lease?: DeviceLease;
  device?: DeviceInfo;
  webDriverSessionId?: string;
  providerSessionId?: string;
}) => Promise<CloudArtifactsResult | undefined>;

export type CloudWebDriverPrepareSession = (params: {
  lease: DeviceLease;
  base: CloudWebDriverBaseSession;
}) => Promise<CloudWebDriverPreparedSession>;

export type CloudWebDriverRuntimeOptions = {
  provider: string;
  endpoint: string | URL;
  platform: CloudWebDriverPlatform;
  deviceName: string;
  webdriverCapabilities?:
    | Record<string, unknown>
    | ((lease: DeviceLease) => Record<string, unknown>);
  auth?: WebDriverAuth;
  headers?: Record<string, string>;
  requestPolicy?: WebDriverRequestPolicy;
  uploadApp?: CloudWebDriverUploadApp;
  listArtifacts?: CloudWebDriverListArtifacts;
  deviceId?: (lease: DeviceLease) => string;
  prepareSession?: CloudWebDriverPrepareSession;
  capabilityOverrides?: CloudWebDriverCapabilityOverrides;
};

type WebDriverProviderSession = {
  lease: DeviceLease;
  device: DeviceInfo;
  client: WebDriverClient;
  interactor: Interactor;
  prepared: CloudWebDriverPreparedSession;
  webDriverSessionId: string;
  providerSessionId: string;
};

export function createCloudWebDriverRuntime(
  options: CloudWebDriverRuntimeOptions,
): ProviderDeviceRuntime {
  return new CloudWebDriverRuntime(options);
}

class CloudWebDriverRuntime implements ProviderDeviceRuntime {
  readonly provider: string;
  readonly leaseLifecycle: LeaseLifecycleProvider;
  readonly cloudArtifacts: CloudArtifactProvider;
  readonly deviceInventoryProvider: DeviceInventoryProvider;
  readonly capabilities: CloudWebDriverProviderCapabilities;

  private readonly sessionsByLeaseId = new Map<string, WebDriverProviderSession>();
  private readonly options: CloudWebDriverRuntimeOptions;

  constructor(options: CloudWebDriverRuntimeOptions) {
    this.options = options;
    this.provider = options.provider;
    this.capabilities = createCloudWebDriverCapabilities({
      provider: options.provider,
      platform: options.platform,
      overrides: options.capabilityOverrides,
    });
    this.leaseLifecycle = {
      allocate: async (lease) => await this.allocate(lease),
      heartbeat: async (lease) => this.heartbeat(lease),
      release: async (lease) => await this.release(lease),
    };
    this.cloudArtifacts = {
      listCloudArtifacts: async (query) => await this.listCloudArtifacts(query),
    };
    this.deviceInventoryProvider = async (request) => {
      if (request.leaseProvider !== this.provider) return null;
      if (!request.leaseId) return [];
      const session = this.sessionsByLeaseId.get(request.leaseId);
      return session ? [session.device] : [];
    };
  }

  ownsDevice(device: DeviceInfo): boolean {
    return [...this.sessionsByLeaseId.values()].some((session) => session.device.id === device.id);
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    return [...this.sessionsByLeaseId.values()].find((session) => session.device.id === device.id)
      ?.interactor;
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    installOptions?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    const session = this.findSessionForDevice(device);
    if (!session) return undefined;
    const upload = await this.uploadAppIfNeeded(session, device, app, appPath, installOptions);
    await session.client.installApp(upload?.appReference ?? appPath);
    return providerInstallResult(upload, installOptions);
  }

  async installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.installApp(device, '', installablePath, options);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.sessionsByLeaseId.values()].map(async (session) => await this.closeSession(session)),
    );
    this.sessionsByLeaseId.clear();
  }

  private async allocate(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const prepared = await this.prepareSession(lease);
    const client = new WebDriverClient({
      endpoint: prepared.endpoint,
      auth: prepared.auth,
      headers: prepared.headers,
      requestPolicy: this.options.requestPolicy,
    });
    const session = await this.createSessionWithPreparedCleanup(client, prepared);
    const device = this.deviceForLease(lease, prepared);
    const providerSessionId = prepared.providerSessionId ?? session.sessionId;
    this.sessionsByLeaseId.set(lease.leaseId, {
      lease,
      device,
      client,
      prepared,
      webDriverSessionId: session.sessionId,
      providerSessionId,
      interactor: createWebDriverInteractor({
        client,
        backend: snapshotBackendForPlatform(prepared.platform),
        capabilities: this.capabilities,
      }),
    });
    return {
      provider: this.provider,
      deviceId: device.id,
      sessionId: session.sessionId,
      providerSessionId,
      capabilities: this.capabilities,
      ...prepared.providerData,
    };
  }

  private async createSessionWithPreparedCleanup(
    client: WebDriverClient,
    prepared: CloudWebDriverPreparedSession,
  ): Promise<Awaited<ReturnType<WebDriverClient['createSession']>>> {
    try {
      return await client.createSession(prepared.webdriverCapabilities);
    } catch (error) {
      await prepared.cleanup?.();
      throw error;
    }
  }

  private heartbeat(lease: DeviceLease): Record<string, unknown> | undefined {
    if (lease.leaseProvider !== this.provider) return undefined;
    if (!this.sessionsByLeaseId.has(lease.leaseId)) return undefined;
    return { provider: this.provider };
  }

  private async release(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const session = this.sessionsByLeaseId.get(lease.leaseId);
    if (!session) return undefined;
    this.sessionsByLeaseId.delete(lease.leaseId);
    const cleanup = await this.closeSession(session);
    const artifacts = await this.safeListArtifacts(session);
    return {
      provider: this.provider,
      providerSessionId: session.providerSessionId,
      ...cleanup,
      ...(artifacts ? { cloudArtifacts: artifacts } : {}),
    };
  }

  private async listCloudArtifacts(
    query: CloudArtifactsQuery,
  ): Promise<CloudArtifactsResult | undefined> {
    if (query.provider !== this.provider) return undefined;
    const session = query.leaseId ? this.sessionsByLeaseId.get(query.leaseId) : undefined;
    if (session) return await this.safeListArtifacts(session);
    if (!query.providerSessionId || !this.options.listArtifacts) return undefined;
    return await this.options.listArtifacts({
      provider: this.provider,
      providerSessionId: query.providerSessionId,
    });
  }

  private async prepareSession(lease: DeviceLease): Promise<CloudWebDriverPreparedSession> {
    const base = this.baseSessionForLease(lease);
    return this.options.prepareSession ? await this.options.prepareSession({ lease, base }) : base;
  }

  private baseSessionForLease(lease: DeviceLease): CloudWebDriverBaseSession {
    const configured =
      typeof this.options.webdriverCapabilities === 'function'
        ? this.options.webdriverCapabilities(lease)
        : (this.options.webdriverCapabilities ?? {});
    return {
      provider: this.provider,
      endpoint: this.options.endpoint,
      platform: this.options.platform,
      deviceName: this.options.deviceName,
      auth: this.options.auth,
      headers: this.options.headers,
      webdriverCapabilities: {
        platformName: this.options.platform === 'ios' ? 'iOS' : 'Android',
        'appium:deviceName': this.options.deviceName,
        ...configured,
      },
    };
  }

  private deviceForLease(lease: DeviceLease, prepared: CloudWebDriverPreparedSession): DeviceInfo {
    return {
      platform: prepared.platform,
      id:
        prepared.deviceId ??
        this.options.deviceId?.(lease) ??
        `${this.provider}:${prepared.platform}:${lease.leaseId}`,
      name: prepared.deviceName,
      kind: 'device',
      target: 'mobile',
      booted: true,
    };
  }

  private findSessionForDevice(device: DeviceInfo): WebDriverProviderSession | undefined {
    return [...this.sessionsByLeaseId.values()].find((session) => session.device.id === device.id);
  }

  private async uploadAppIfNeeded(
    session: WebDriverProviderSession,
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<CloudWebDriverUploadResult | undefined> {
    if (!capabilitySupported(this.capabilities, 'install')) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        unsupportedCapabilityMessage(this.capabilities, 'install'),
        { provider: this.provider, deviceId: device.id, platform: device.platform },
      );
    }
    const uploadApp = session.prepared.uploadApp ?? this.options.uploadApp;
    if (!uploadApp) return undefined;
    return await uploadApp({
      provider: this.provider,
      lease: session.lease,
      device,
      app,
      appPath,
      options,
    });
  }

  private async closeSession(
    session: WebDriverProviderSession,
  ): Promise<Record<string, unknown> | undefined> {
    let cleanupResult: Record<string, unknown> | undefined;
    try {
      await session.client.deleteSession();
    } finally {
      cleanupResult = await session.prepared.cleanup?.();
    }
    return cleanupResult;
  }

  private async safeListArtifacts(
    session: WebDriverProviderSession,
  ): Promise<CloudArtifactsResult | undefined> {
    const listArtifacts = session.prepared.listArtifacts ?? this.options.listArtifacts;
    if (!listArtifacts) return undefined;
    try {
      return await listArtifacts({
        provider: this.provider,
        lease: session.lease,
        device: session.device,
        webDriverSessionId: session.webDriverSessionId,
        providerSessionId: session.providerSessionId,
      });
    } catch (error) {
      return {
        provider: this.provider,
        providerSessionId: session.providerSessionId,
        status: 'unavailable',
        cloudArtifacts: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
