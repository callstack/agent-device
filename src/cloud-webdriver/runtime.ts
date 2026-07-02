import type {
  CloudArtifactProvider,
  CloudArtifactsQuery,
  CloudArtifactsResult,
} from '../cloud-artifacts.ts';
import type { DeviceInventoryProvider } from '../core/dispatch-resolve.ts';
import type { Interactor } from '../core/interactor-types.ts';
import type { LeaseLifecycleProvider } from '../daemon/handlers/lease.ts';
import type { DeviceLease } from '../daemon/lease-registry.ts';
import type { DaemonRequest } from '../daemon/types.ts';
import type {
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
} from '../provider-device-runtime.ts';
import {
  deviceFieldsFromPublicPlatform,
  publicPlatformString,
  type DeviceInfo,
} from '../kernel/device.ts';
import { AppError } from '../kernel/errors.ts';
import { unavailableCloudArtifactsResult } from './artifact-results.ts';
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

export type CloudWebDriverPlatform = 'android' | 'ios';

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
  req?: DaemonRequest;
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
  capabilities: CloudWebDriverProviderCapabilities;
  webDriverSessionId: string;
  providerSessionId: string;
};

type CloudWebDriverReleaseWarning = {
  code: 'WEBDRIVER_SESSION_DELETE_FAILED' | 'PROVIDER_CLEANUP_FAILED';
  message: string;
};

type CloudWebDriverCloseResult = {
  cleanup?: Record<string, unknown>;
  warnings: CloudWebDriverReleaseWarning[];
};

export function createCloudWebDriverRuntime(
  options: CloudWebDriverRuntimeOptions,
): ProviderDeviceRuntime {
  return new CloudWebDriverRuntime(options);
}

export function buildCloudWebDriverBaseCapabilities(
  platform: CloudWebDriverPlatform,
  deviceName: string,
  configured: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    platformName: platform === 'ios' ? 'iOS' : 'Android',
    'appium:deviceName': deviceName,
    ...configured,
  };
}

class CloudWebDriverRuntime implements ProviderDeviceRuntime {
  readonly provider: string;
  readonly leaseLifecycle: LeaseLifecycleProvider;
  readonly cloudArtifacts: CloudArtifactProvider;
  readonly deviceInventoryProvider: DeviceInventoryProvider;
  readonly capabilities: CloudWebDriverProviderCapabilities;

  private readonly sessionsByLeaseId = new Map<string, WebDriverProviderSession>();
  private readonly releasedProviderSessionIdsByLeaseId = new Map<string, string>();
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
      allocate: async (lease, context) => await this.allocate(lease, context?.req),
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

  private async allocate(
    lease: DeviceLease,
    req?: DaemonRequest,
  ): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    if (this.sessionsByLeaseId.has(lease.leaseId)) return this.heartbeat(lease);
    const prepared = await this.prepareSession(lease, req);
    const client = new WebDriverClient({
      endpoint: prepared.endpoint,
      auth: prepared.auth,
      headers: prepared.headers,
      requestPolicy: this.options.requestPolicy,
    });
    const session = await this.createSessionWithPreparedCleanup(client, prepared);
    const device = this.deviceForLease(lease, prepared);
    const providerSessionId = prepared.providerSessionId ?? session.sessionId;
    const capabilities = this.capabilitiesForPlatform(prepared.platform);
    this.sessionsByLeaseId.set(lease.leaseId, {
      lease,
      device,
      client,
      prepared,
      capabilities,
      webDriverSessionId: session.sessionId,
      providerSessionId,
      interactor: createWebDriverInteractor({
        client,
        backend: snapshotBackendForPlatform(prepared.platform),
        capabilities,
      }),
    });
    return {
      provider: this.provider,
      deviceId: device.id,
      sessionId: session.sessionId,
      providerSessionId,
      capabilities,
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
      await cleanupAfterCreateSessionFailure(prepared, error);
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
    this.releasedProviderSessionIdsByLeaseId.set(lease.leaseId, session.providerSessionId);
    const close = await this.closeSession(session);
    const artifacts = await this.safeListArtifacts(session);
    return {
      provider: this.provider,
      providerSessionId: session.providerSessionId,
      ...close.cleanup,
      ...(close.warnings.length > 0 ? { warnings: close.warnings } : {}),
      ...(artifacts ? { cloudArtifacts: artifacts } : {}),
    };
  }

  private async listCloudArtifacts(
    query: CloudArtifactsQuery,
  ): Promise<CloudArtifactsResult | undefined> {
    if (query.provider !== this.provider) return undefined;
    const session = query.leaseId ? this.sessionsByLeaseId.get(query.leaseId) : undefined;
    if (session) return await this.safeListArtifacts(session);
    const providerSessionId =
      query.providerSessionId ??
      (query.leaseId ? this.releasedProviderSessionIdsByLeaseId.get(query.leaseId) : undefined);
    if (!providerSessionId || !this.options.listArtifacts) return undefined;
    return await this.options.listArtifacts({
      provider: this.provider,
      providerSessionId,
    });
  }

  private async prepareSession(
    lease: DeviceLease,
    req: DaemonRequest | undefined,
  ): Promise<CloudWebDriverPreparedSession> {
    const base = this.baseSessionForLease(lease);
    return this.options.prepareSession
      ? await this.options.prepareSession({ lease, req, base })
      : base;
  }

  private capabilitiesForPlatform(
    platform: CloudWebDriverPlatform,
  ): CloudWebDriverProviderCapabilities {
    return createCloudWebDriverCapabilities({
      provider: this.provider,
      platform,
      overrides: this.options.capabilityOverrides,
    });
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
      webdriverCapabilities: buildCloudWebDriverBaseCapabilities(
        this.options.platform,
        this.options.deviceName,
        configured,
      ),
    };
  }

  private deviceForLease(lease: DeviceLease, prepared: CloudWebDriverPreparedSession): DeviceInfo {
    return {
      ...deviceFieldsFromPublicPlatform(prepared.platform),
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
    if (!capabilitySupported(session.capabilities, 'install')) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        unsupportedCapabilityMessage(session.capabilities, 'install'),
        { provider: this.provider, deviceId: device.id, platform: publicPlatformString(device) },
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
  ): Promise<CloudWebDriverCloseResult> {
    const warnings: CloudWebDriverReleaseWarning[] = [];
    let cleanup: Record<string, unknown> | undefined;
    try {
      await session.client.deleteSession();
    } catch (error) {
      warnings.push({
        code: 'WEBDRIVER_SESSION_DELETE_FAILED',
        message: errorMessage(error),
      });
    }
    try {
      cleanup = await session.prepared.cleanup?.();
    } catch (error) {
      warnings.push({
        code: 'PROVIDER_CLEANUP_FAILED',
        message: errorMessage(error),
      });
    }
    return { cleanup, warnings };
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
      return unavailableCloudArtifactsResult({
        provider: this.provider,
        providerSessionId: session.providerSessionId,
        error,
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupAfterCreateSessionFailure(
  prepared: CloudWebDriverPreparedSession,
  primaryError: unknown,
): Promise<void> {
  try {
    await prepared.cleanup?.();
  } catch (cleanupError) {
    if (primaryError instanceof AppError) {
      primaryError.details = {
        ...primaryError.details,
        cleanupError: errorMessage(cleanupError),
      };
    }
  }
}
