import { AsyncLocalStorage } from 'node:async_hooks';
import type { Interactor } from './core/interactor-types.ts';
import type { DeviceInventoryProvider } from './core/dispatch-resolve.ts';
import type { LeaseLifecycleProvider } from './daemon/handlers/lease.ts';
import type { DeviceLease } from './daemon/lease-registry.ts';
import type { DeviceInfo } from './kernel/device.ts';
import { AppError } from './kernel/errors.ts';

export type ProviderDeviceInstallResult = {
  bundleId?: string;
  packageName?: string;
  appName?: string;
  launchTarget?: string;
};

export type ProviderDeviceInstallOptions = {
  relaunch?: boolean;
  appIdentifierHint?: string;
  packageNameHint?: string;
};

export type ProviderDeviceRuntime = {
  provider: string;
  leaseLifecycle: LeaseLifecycleProvider;
  deviceInventoryProvider: DeviceInventoryProvider;
  ownsDevice(device: DeviceInfo): boolean;
  getInteractor(device: DeviceInfo): Interactor | undefined;
  installApp?(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined>;
  installInstallablePath?(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined>;
  configurePortReverse?(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined>;
  removePortReverse?(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined>;
  shutdown(): Promise<void>;
};

export type ProviderPortReverseOptions = {
  leaseId: string;
  provider?: string;
  devicePort: number;
  hostPort: number;
  name: string;
};

export type ProviderDeviceRuntimeRequestProviders = {
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  deviceInventoryProvider?: DeviceInventoryProvider;
  providerDeviceRuntimeScope?: <T>(task: () => Promise<T>) => Promise<T>;
};

let activeProviderDeviceRuntimes: ProviderDeviceRuntime[] = [];
const providerDeviceRuntimeScope = new AsyncLocalStorage<ProviderDeviceRuntime[]>();

export function setActiveProviderDeviceRuntimes(runtimes: ProviderDeviceRuntime[]): void {
  activeProviderDeviceRuntimes = [...runtimes];
}

async function withProviderDeviceRuntimeScope<T>(
  runtimes: ProviderDeviceRuntime[],
  task: () => Promise<T>,
): Promise<T> {
  return await providerDeviceRuntimeScope.run([...runtimes], task);
}

export function getProviderDeviceInteractor(device: DeviceInfo): Interactor | undefined {
  for (const runtime of getActiveProviderDeviceRuntimes()) {
    if (!runtime.ownsDevice(device)) continue;
    const interactor = runtime.getInteractor(device);
    if (interactor) return interactor;
  }
  return undefined;
}

export function isActiveProviderDevice(device: DeviceInfo): boolean {
  return getActiveProviderDeviceRuntimes().some((runtime) => runtime.ownsDevice(device));
}

export async function installProviderDeviceApp(
  device: DeviceInfo,
  app: string,
  appPath: string,
  options?: ProviderDeviceInstallOptions,
): Promise<ProviderDeviceInstallResult | undefined> {
  for (const runtime of getActiveProviderDeviceRuntimes()) {
    if (!runtime.ownsDevice(device)) continue;
    if (!runtime.installApp) {
      throw unsupportedProviderOperation(runtime, device, 'install');
    }
    const result = await runtime.installApp?.(device, app, appPath, options);
    if (result) return result;
    throw unsupportedProviderOperation(runtime, device, 'install');
  }
  return undefined;
}

export async function installProviderDeviceInstallablePath(
  device: DeviceInfo,
  installablePath: string,
  options?: ProviderDeviceInstallOptions,
): Promise<ProviderDeviceInstallResult | undefined> {
  for (const runtime of getActiveProviderDeviceRuntimes()) {
    if (!runtime.ownsDevice(device)) continue;
    if (!runtime.installInstallablePath) {
      throw unsupportedProviderOperation(runtime, device, 'install_from_source');
    }
    const result = await runtime.installInstallablePath?.(device, installablePath, options);
    if (result) return result;
    throw unsupportedProviderOperation(runtime, device, 'install_from_source');
  }
  return undefined;
}

export async function configureProviderPortReverse(
  options: ProviderPortReverseOptions,
): Promise<Record<string, unknown> | undefined> {
  for (const runtime of getActiveProviderDeviceRuntimes()) {
    if (!runtimeMatchesProvider(runtime, options.provider)) continue;
    const result = await runtime.configurePortReverse?.(options);
    if (result) return result;
  }
  return undefined;
}

export async function removeProviderPortReverse(
  options: ProviderPortReverseOptions,
): Promise<Record<string, unknown> | undefined> {
  for (const runtime of getActiveProviderDeviceRuntimes()) {
    if (!runtimeMatchesProvider(runtime, options.provider)) continue;
    const result = await runtime.removePortReverse?.(options);
    if (result) return result;
  }
  return undefined;
}

function getActiveProviderDeviceRuntimes(): ProviderDeviceRuntime[] {
  return providerDeviceRuntimeScope.getStore() ?? activeProviderDeviceRuntimes;
}

export function createProviderDeviceRuntimeRequestProviders(
  runtimes: ProviderDeviceRuntime[],
): ProviderDeviceRuntimeRequestProviders {
  return {
    leaseLifecycleProvider: composeLeaseProvider(runtimes),
    deviceInventoryProvider: composeDeviceInventoryProvider(runtimes),
    providerDeviceRuntimeScope: async (task) =>
      await withProviderDeviceRuntimeScope(runtimes, task),
  };
}

function composeLeaseProvider(
  runtimes: ProviderDeviceRuntime[],
): LeaseLifecycleProvider | undefined {
  if (runtimes.length === 0) return undefined;
  return {
    allocate: async (lease) => await firstProviderResult(runtimes, 'allocate', lease),
    heartbeat: async (lease) => await firstProviderResult(runtimes, 'heartbeat', lease),
    release: async (lease) => await firstProviderResult(runtimes, 'release', lease),
  };
}

function composeDeviceInventoryProvider(
  runtimes: ProviderDeviceRuntime[],
): DeviceInventoryProvider | undefined {
  if (runtimes.length === 0) return undefined;
  return async (request) => {
    for (const runtime of runtimes) {
      if (!runtimeMatchesProvider(runtime, request.leaseProvider)) continue;
      const devices = await runtime.deviceInventoryProvider(request);
      if (devices) return devices;
    }
    return null;
  };
}

async function firstProviderResult(
  runtimes: ProviderDeviceRuntime[],
  method: keyof LeaseLifecycleProvider,
  lease: DeviceLease,
): Promise<Record<string, unknown> | undefined> {
  for (const runtime of runtimes) {
    if (!runtimeMatchesProvider(runtime, lease.leaseProvider)) continue;
    const handler = runtime.leaseLifecycle[method];
    const result = handler ? await handler(lease) : undefined;
    if (result) return result;
  }
  return undefined;
}

function runtimeMatchesProvider(
  runtime: ProviderDeviceRuntime,
  provider: string | undefined,
): boolean {
  return runtime.provider === provider;
}

function unsupportedProviderOperation(
  runtime: ProviderDeviceRuntime,
  device: DeviceInfo,
  operation: string,
): never {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `Provider device runtime ${runtime.provider} does not support ${operation} for this device.`,
    { provider: runtime.provider, deviceId: device.id, platform: device.platform },
  );
}
