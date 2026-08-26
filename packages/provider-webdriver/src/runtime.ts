import type {
  CloudArtifactProvider,
  CloudArtifactsResult,
} from '@agent-device/contracts/observability';
import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleContext,
  LeaseLifecycleProvider,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
} from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  createCloudWebDriverCapabilities,
  type CloudWebDriverCapabilityOverrides,
  type CloudWebDriverProviderCapabilities,
} from './capabilities.ts';
import { createWebDriverDeploymentRuntime } from './runtime-deployment.ts';
import { WebDriverSessionManager } from './runtime-session.ts';
import type { WebDriverAuth, WebDriverRequestPolicy } from './webdriver-client.ts';

export type CloudWebDriverPlatform = 'android' | 'ios';

export type CloudWebDriverUploadResult = ProviderDeviceInstallResult & {
  appReference: string;
};

/** A provider-owned runtime that also advertises its lazy platform-runtime module. */
export type CloudWebDriverRuntime = ProviderDeviceRuntime &
  Readonly<{
    platformRuntimeModule: PlatformRuntimeProviderModule;
  }>;

export type CloudWebDriverUploadApp = (params: {
  provider: string;
  lease: DeviceLease;
  device: DeviceInfo;
  app: string;
  appPath: string;
  options?: ProviderDeviceInstallOptions;
  signal?: AbortSignal;
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
  req?: LeaseLifecycleContext;
  base: CloudWebDriverBaseSession;
}) => Promise<CloudWebDriverPreparedSession>;

export type CloudWebDriverRuntimeOptions = {
  clientVersion: string;
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

export function createCloudWebDriverRuntime(
  options: CloudWebDriverRuntimeOptions,
): CloudWebDriverRuntime {
  return new CloudWebDriverRuntimeImplementation(options);
}

export { buildCloudWebDriverBaseCapabilities } from './runtime-session.ts';

/** Public façade: provider wiring stays small while session/deployment mechanics stay focused. */
class CloudWebDriverRuntimeImplementation implements CloudWebDriverRuntime {
  readonly provider: string;
  readonly owner: PlatformRuntimeProviderModule['owner'];
  readonly leaseLifecycle: LeaseLifecycleProvider;
  readonly cloudArtifacts: CloudArtifactProvider;
  readonly deviceInventoryProvider: DeviceInventoryProvider;
  readonly capabilities: CloudWebDriverProviderCapabilities;
  readonly platformRuntimeModule: PlatformRuntimeProviderModule;

  private readonly sessions: WebDriverSessionManager;
  private readonly deployment: ReturnType<typeof createWebDriverDeploymentRuntime>;

  constructor(options: CloudWebDriverRuntimeOptions) {
    this.provider = options.provider;
    this.owner = providerRuntimeOwner(options.provider, options.platform);
    this.capabilities = createCloudWebDriverCapabilities({
      provider: options.provider,
      platform: options.platform,
      overrides: options.capabilityOverrides,
    });
    this.sessions = new WebDriverSessionManager(options);
    this.deployment = createWebDriverDeploymentRuntime({
      provider: options.provider,
      uploadApp: options.uploadApp,
      findSessionForDevice: (device) => this.sessions.findSessionForDevice(device),
    });
    this.platformRuntimeModule = Object.freeze({
      owner: this.owner,
      loadRuntime: async (host) => await this.loadRuntime(host),
    });
    this.leaseLifecycle = {
      allocate: async (lease, context) => await this.sessions.allocate(lease, context),
      heartbeat: async (lease) => this.sessions.heartbeat(lease),
      release: async (lease) => await this.sessions.release(lease),
    };
    this.cloudArtifacts = {
      listCloudArtifacts: async (query) => await this.sessions.listCloudArtifacts(query),
    };
    this.deviceInventoryProvider = async (request) => {
      if (request.leaseProvider !== this.provider) return null;
      if (!request.leaseId) return [];
      const session = this.sessions.findSessionForLease(request.leaseId);
      return session ? [session.device] : [];
    };
  }

  async loadRuntime(host: PlatformRuntimeHost): Promise<PlatformRuntimeOwner> {
    const { createWebDriverPlatformRuntimeOwner } = await import('./platform-runtime.ts');
    return createWebDriverPlatformRuntimeOwner({
      host,
      owner: this.owner,
      ownsDevice: (device) => this.ownsDevice(device),
      isSessionActive: (device) => this.sessions.findSessionForDevice(device) !== undefined,
      deployment: this.deployment,
      capabilities: this.capabilities,
      snapshotAvailable: this.capabilities.operations.snapshot.support !== 'unsupported',
      screenshotAvailable: this.capabilities.operations.screenshot.support !== 'unsupported',
      getInteractor: (device) => this.getInteractor(device),
    });
  }

  ownsDevice(device: DeviceInfo): boolean {
    return this.sessions.ownsDevice(device);
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    return this.sessions.getInteractor(device);
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    installOptions?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.deployment.installApp(device, app, appPath, installOptions);
  }

  async installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    installOptions?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.deployment.installInstallablePath(device, installablePath, installOptions);
  }

  async shutdown(): Promise<void> {
    await this.sessions.shutdown();
  }
}
