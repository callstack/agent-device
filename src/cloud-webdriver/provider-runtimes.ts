import fs from 'node:fs';
import path from 'node:path';
import type {
  CloudArtifactProvider,
  CloudArtifactsQuery,
  CloudArtifactsResult,
} from '../cloud-artifacts.ts';
import type { DeviceInventoryProvider } from '../core/dispatch-resolve.ts';
import type { Interactor } from '../core/interactor-types.ts';
import type { LeaseLifecycleContext, LeaseLifecycleProvider } from '../daemon/handlers/lease.ts';
import type { DeviceLease } from '../daemon/lease-registry.ts';
import type { DaemonRequest } from '../daemon/types.ts';
import type { DeviceInfo } from '../kernel/device.ts';
import { AppError } from '../kernel/errors.ts';
import {
  type ProviderDeviceInstallOptions,
  type ProviderDeviceInstallResult,
  type ProviderDeviceRuntime,
  type ProviderPortReverseOptions,
} from '../provider-device-runtime.ts';
import { createAwsDeviceFarmWebDriverRuntime } from './aws-device-farm.ts';
import { createBrowserStackWebDriverRuntime, uploadBrowserStackApp } from './browserstack.ts';
import { CLOUD_WEBDRIVER_PROVIDERS, type CloudWebDriverKnownProviderName } from './providers.ts';
import type { DefaultCloudWebDriverArtifactEnv } from './provider-registry.ts';
import type { CloudWebDriverPlatform } from './runtime.ts';

export type DefaultCloudWebDriverProviderRuntimeEnv = DefaultCloudWebDriverArtifactEnv & {
  BROWSERSTACK_WEBDRIVER_ENDPOINT?: string;
  BROWSERSTACK_APP_UPLOAD_ENDPOINT?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN?: string;
  AWS_DEVICE_FARM_PROJECT_ARN?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN?: string;
  AWS_DEVICE_FARM_DEVICE_ARN?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN?: string;
  AWS_DEVICE_FARM_APP_ARN?: string;
};

export function createDefaultCloudWebDriverProviderRuntimes(
  env: DefaultCloudWebDriverProviderRuntimeEnv = process.env,
): ProviderDeviceRuntime[] {
  return [
    new LazyCloudWebDriverProviderRuntime(CLOUD_WEBDRIVER_PROVIDERS.browserStack, env),
    new LazyCloudWebDriverProviderRuntime(CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm, env),
  ];
}

class LazyCloudWebDriverProviderRuntime implements ProviderDeviceRuntime {
  readonly leaseLifecycle: LeaseLifecycleProvider;
  readonly cloudArtifacts: CloudArtifactProvider;
  readonly deviceInventoryProvider: DeviceInventoryProvider;
  readonly provider: CloudWebDriverKnownProviderName;

  private readonly env: DefaultCloudWebDriverProviderRuntimeEnv;
  private readonly runtimesByLeaseId = new Map<string, ProviderDeviceRuntime>();

  constructor(
    provider: CloudWebDriverKnownProviderName,
    env: DefaultCloudWebDriverProviderRuntimeEnv,
  ) {
    this.provider = provider;
    this.env = env;
    this.leaseLifecycle = {
      allocate: async (lease, context) => await this.allocate(lease, context),
      heartbeat: async (lease, context) => await this.heartbeat(lease, context),
      release: async (lease, context) => await this.release(lease, context),
    };
    this.cloudArtifacts = {
      listCloudArtifacts: async (query) => await this.listCloudArtifacts(query),
    };
    this.deviceInventoryProvider = async (request) => {
      if (request.leaseProvider !== this.provider) return null;
      if (!request.leaseId) return [];
      return (
        (await this.runtimesByLeaseId.get(request.leaseId)?.deviceInventoryProvider(request)) ?? []
      );
    };
  }

  ownsDevice(device: DeviceInfo): boolean {
    return this.findRuntimeForDevice(device) !== undefined;
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    return this.findRuntimeForDevice(device)?.getInteractor(device);
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.findRuntimeForDevice(device)?.installApp?.(device, app, appPath, options);
  }

  async installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.findRuntimeForDevice(device)?.installInstallablePath?.(
      device,
      installablePath,
      options,
    );
  }

  async configurePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    return await this.runtimesByLeaseId.get(options.leaseId)?.configurePortReverse?.(options);
  }

  async removePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    return await this.runtimesByLeaseId.get(options.leaseId)?.removePortReverse?.(options);
  }

  async shutdown(): Promise<void> {
    const runtimes = [...this.runtimesByLeaseId.values()];
    this.runtimesByLeaseId.clear();
    await Promise.allSettled(runtimes.map(async (runtime) => await runtime.shutdown()));
  }

  private async allocate(
    lease: DeviceLease,
    context: LeaseLifecycleContext | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const existing = this.runtimesByLeaseId.get(lease.leaseId);
    if (existing) return await existing.leaseLifecycle.heartbeat?.(lease, context);
    const runtime = await this.createRuntime(context?.req, lease);
    this.runtimesByLeaseId.set(lease.leaseId, runtime);
    try {
      return await runtime.leaseLifecycle.allocate?.(lease, context);
    } catch (error) {
      this.runtimesByLeaseId.delete(lease.leaseId);
      await runtime.shutdown();
      throw error;
    }
  }

  private async heartbeat(
    lease: DeviceLease,
    context: LeaseLifecycleContext | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    return await this.runtimesByLeaseId
      .get(lease.leaseId)
      ?.leaseLifecycle.heartbeat?.(lease, context);
  }

  private async release(
    lease: DeviceLease,
    context: LeaseLifecycleContext | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const runtime = this.runtimesByLeaseId.get(lease.leaseId);
    if (!runtime) return undefined;
    this.runtimesByLeaseId.delete(lease.leaseId);
    try {
      return await runtime.leaseLifecycle.release?.(lease, context);
    } finally {
      await runtime.shutdown();
    }
  }

  private async listCloudArtifacts(
    query: CloudArtifactsQuery,
  ): Promise<CloudArtifactsResult | undefined> {
    if (query.provider !== this.provider) return undefined;
    if (!query.leaseId) return undefined;
    return await this.runtimesByLeaseId
      .get(query.leaseId)
      ?.cloudArtifacts?.listCloudArtifacts?.(query);
  }

  private findRuntimeForDevice(device: DeviceInfo): ProviderDeviceRuntime | undefined {
    return [...this.runtimesByLeaseId.values()].find((runtime) => runtime.ownsDevice(device));
  }

  private async createRuntime(
    req: DaemonRequest | undefined,
    lease: DeviceLease,
  ): Promise<ProviderDeviceRuntime> {
    if (!req) {
      throw new AppError(
        'INVALID_ARGS',
        `${this.provider} lease allocation requires provider profile flags on the request.`,
      );
    }
    return this.provider === CLOUD_WEBDRIVER_PROVIDERS.browserStack
      ? await this.createBrowserStackRuntime(req, lease)
      : this.createAwsDeviceFarmRuntime(req, lease);
  }

  private async createBrowserStackRuntime(
    req: DaemonRequest,
    lease: DeviceLease,
  ): Promise<ProviderDeviceRuntime> {
    const username = requireEnv(this.env, 'BROWSERSTACK_USERNAME', 'BrowserStack');
    const accessKey = requireEnv(this.env, 'BROWSERSTACK_ACCESS_KEY', 'BrowserStack');
    const platform = requireRequestPlatform(req, 'BrowserStack');
    const deviceName = requireFlag(req, 'device', 'BrowserStack requires --device <name>.');
    const osVersion = requireFlag(
      req,
      'providerOsVersion',
      'BrowserStack requires --provider-os-version <version>.',
    );
    const app = await resolveBrowserStackAppReference({
      app: requireFlag(
        req,
        'providerApp',
        'BrowserStack requires --provider-app <bs://app-id-or-local-path>.',
      ),
      cwd: req.meta?.cwd,
      username,
      accessKey,
      uploadEndpoint: this.env.BROWSERSTACK_APP_UPLOAD_ENDPOINT,
    });
    return createBrowserStackWebDriverRuntime({
      username,
      accessKey,
      platform,
      deviceName,
      osVersion,
      app,
      projectName: readFlag(req, 'providerProject'),
      buildName: readFlag(req, 'providerBuild') ?? lease.runId,
      sessionName: readFlag(req, 'providerSessionName') ?? lease.leaseId,
      endpoint: this.env.BROWSERSTACK_WEBDRIVER_ENDPOINT,
      uploadEndpoint: this.env.BROWSERSTACK_APP_UPLOAD_ENDPOINT,
      sessionDetailsEndpoint: this.env.BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
    });
  }

  private createAwsDeviceFarmRuntime(
    req: DaemonRequest,
    lease: DeviceLease,
  ): ProviderDeviceRuntime {
    const platform = requireRequestPlatform(req, 'AWS Device Farm');
    return createAwsDeviceFarmWebDriverRuntime({
      projectArn: requireAwsValue(
        req,
        this.env,
        'awsProjectArn',
        'AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN',
        'AWS_DEVICE_FARM_PROJECT_ARN',
      ),
      deviceArn: requireAwsValue(
        req,
        this.env,
        'awsDeviceArn',
        'AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN',
        'AWS_DEVICE_FARM_DEVICE_ARN',
      ),
      appArn:
        readFlag(req, 'awsAppArn') ??
        this.env.AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN ??
        this.env.AWS_DEVICE_FARM_APP_ARN,
      region: readFlag(req, 'awsRegion') ?? this.env.AWS_REGION ?? this.env.AWS_DEFAULT_REGION,
      platform,
      deviceName: readFlag(req, 'device') ?? 'AWS Device Farm device',
      sessionName: readFlag(req, 'providerSessionName') ?? lease.leaseId,
      interactionMode: readAwsInteractionMode(req),
    });
  }
}

async function resolveBrowserStackAppReference(options: {
  app: string;
  cwd?: string;
  username: string;
  accessKey: string;
  uploadEndpoint?: string;
}): Promise<string> {
  if (isProviderAppReference(options.app)) return options.app;
  const appPath = path.resolve(options.cwd ?? process.cwd(), options.app);
  if (!fs.existsSync(appPath)) {
    throw new AppError(
      'INVALID_ARGS',
      'BrowserStack --provider-app must be a bs:// app id, URL, or existing local app path.',
      { providerApp: options.app },
    );
  }
  return await uploadBrowserStackApp(appPath, {
    username: options.username,
    accessKey: options.accessKey,
    endpoint: options.uploadEndpoint,
  });
}

function isProviderAppReference(value: string): boolean {
  return value.startsWith('bs://') || /^https?:\/\//.test(value);
}

function requireRequestPlatform(req: DaemonRequest, providerLabel: string): CloudWebDriverPlatform {
  const platform = req.flags?.platform;
  if (platform === 'android' || platform === 'ios') return platform;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires --platform ios|android.`);
}

function requireFlag(
  req: DaemonRequest,
  key: keyof NonNullable<DaemonRequest['flags']>,
  message: string,
): string {
  const value = readFlag(req, key);
  if (value) return value;
  throw new AppError('INVALID_ARGS', message);
}

function readFlag(
  req: DaemonRequest,
  key: keyof NonNullable<DaemonRequest['flags']>,
): string | undefined {
  const value = req.flags?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireEnv(
  env: DefaultCloudWebDriverProviderRuntimeEnv,
  key: keyof DefaultCloudWebDriverProviderRuntimeEnv,
  providerLabel: string,
): string {
  const value = env[key];
  if (value) return value;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires ${key} in the environment.`);
}

function requireAwsValue(
  req: DaemonRequest,
  env: DefaultCloudWebDriverProviderRuntimeEnv,
  flagKey: keyof NonNullable<DaemonRequest['flags']>,
  primaryEnv: keyof DefaultCloudWebDriverProviderRuntimeEnv,
  fallbackEnv: keyof DefaultCloudWebDriverProviderRuntimeEnv,
): string {
  const value = readFlag(req, flagKey) ?? env[primaryEnv] ?? env[fallbackEnv];
  if (value) return value;
  throw new AppError(
    'INVALID_ARGS',
    `AWS Device Farm requires --${dasherize(String(flagKey))} or ${fallbackEnv}.`,
  );
}

function readAwsInteractionMode(
  req: DaemonRequest,
): 'INTERACTIVE' | 'NO_VIDEO' | 'VIDEO_ONLY' | undefined {
  const value = readFlag(req, 'awsInteractionMode');
  if (value === 'INTERACTIVE' || value === 'NO_VIDEO' || value === 'VIDEO_ONLY') return value;
  return undefined;
}

function dasherize(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
