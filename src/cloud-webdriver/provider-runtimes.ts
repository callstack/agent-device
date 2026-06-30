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
import {
  CLOUD_WEBDRIVER_PROVIDER_DEFINITIONS,
  type CloudWebDriverProviderDefinition,
  type DefaultCloudWebDriverProviderRuntimeEnv,
} from './provider-definitions.ts';

export type { DefaultCloudWebDriverProviderRuntimeEnv } from './provider-definitions.ts';

export function createDefaultCloudWebDriverProviderRuntimes(
  env: DefaultCloudWebDriverProviderRuntimeEnv = process.env,
): ProviderDeviceRuntime[] {
  return CLOUD_WEBDRIVER_PROVIDER_DEFINITIONS.map(
    (definition) => new LazyCloudWebDriverProviderRuntime(definition, env),
  );
}

class LazyCloudWebDriverProviderRuntime implements ProviderDeviceRuntime {
  readonly leaseLifecycle: LeaseLifecycleProvider;
  readonly cloudArtifacts: CloudArtifactProvider;
  readonly deviceInventoryProvider: DeviceInventoryProvider;
  readonly provider: CloudWebDriverProviderDefinition['provider'];

  private readonly definition: CloudWebDriverProviderDefinition;
  private readonly env: DefaultCloudWebDriverProviderRuntimeEnv;
  private readonly runtimesByLeaseId = new Map<string, ProviderDeviceRuntime>();

  constructor(
    definition: CloudWebDriverProviderDefinition,
    env: DefaultCloudWebDriverProviderRuntimeEnv,
  ) {
    this.definition = definition;
    this.provider = definition.provider;
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
    return await this.definition.createRuntime({ req, lease, env: this.env });
  }
}
