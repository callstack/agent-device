import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleContext,
  LeaseLifecycleProvider,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
  ProviderExpiredLeaseRecovery,
  ProviderPortReverseOptions,
} from '@agent-device/contracts/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import type {
  CloudArtifactProvider,
  CloudArtifactsQuery,
  CloudArtifactsResult,
} from '@agent-device/contracts/observability';
import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AppleRunnerProviderResolver } from './daemon/request-platform-providers.ts';
import type {
  AppleRunnerCommandExecutor,
  AppleRunnerProvider,
} from './platforms/apple/core/runner/runner-provider.ts';

type AppleRunnerRuntimeExtension = ProviderDeviceRuntime & {
  getAppleRunnerProvider(
    device: DeviceInfo,
  ): AppleRunnerProvider | AppleRunnerCommandExecutor | undefined;
};

export type ProviderDeviceRuntimeRequestProviders = {
  providerRuntimeIds: readonly string[];
  providerRuntimeRequiredIds: readonly string[];
  recoverableProviderIds: readonly string[];
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  recoverExpiredLease?: ProviderExpiredLeaseRecovery;
  cloudArtifactProvider?: CloudArtifactProvider;
  deviceInventoryProvider?: DeviceInventoryProvider;
  appleRunnerProvider?: AppleRunnerProviderResolver;
  providerDeviceRuntimeScope?: <T>(task: () => Promise<T>) => Promise<T>;
};

let activeProviderDeviceRuntimes: ProviderDeviceRuntime[] = [];
const providerDeviceRuntimeScope = new AsyncLocalStorage<ProviderDeviceRuntime[]>();

/**
 * @internal Test isolation hook for the active provider runtime scope.
 */
export function setActiveProviderDeviceRuntimes(runtimes: ProviderDeviceRuntime[]): void {
  activeProviderDeviceRuntimes = [...runtimes];
}

async function withProviderDeviceRuntimeScope<T>(
  runtimes: ProviderDeviceRuntime[],
  task: () => Promise<T>,
): Promise<T> {
  return await providerDeviceRuntimeScope.run([...runtimes], task);
}

export function getProviderDeviceInteractor(
  device: DeviceInfo,
  runnerContext?: RunnerContext,
): Interactor | undefined {
  for (const runtime of getActiveProviderDeviceRuntimes()) {
    if (!runtime.ownsDevice(device)) continue;
    const interactor = runtime.getInteractor(device, runnerContext);
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

function getActiveProviderDeviceRuntimes(): ProviderDeviceRuntime[] {
  return providerDeviceRuntimeScope.getStore() ?? activeProviderDeviceRuntimes;
}

export function createProviderDeviceRuntimeRequestProviders(
  runtimes: ProviderDeviceRuntime[],
  options: { providerRuntimeRequiredIds?: readonly string[] } = {},
): ProviderDeviceRuntimeRequestProviders {
  const providerRuntimeIds = runtimes.map((runtime) => runtime.provider);
  return {
    providerRuntimeIds,
    providerRuntimeRequiredIds: uniqueProviderIds([
      ...providerRuntimeIds,
      ...(options.providerRuntimeRequiredIds ?? []),
    ]),
    leaseLifecycleProvider: composeLeaseProvider(runtimes),
    recoverableProviderIds: runtimes
      .filter((runtime) => runtime.recoverExpiredLease !== undefined)
      .map((runtime) => runtime.provider),
    recoverExpiredLease: composeExpiredLeaseRecovery(runtimes),
    cloudArtifactProvider: composeCloudArtifactProvider(runtimes),
    deviceInventoryProvider: composeDeviceInventoryProvider(runtimes),
    appleRunnerProvider: composeAppleRunnerProviderResolver(runtimes),
    providerDeviceRuntimeScope: async (task) =>
      await withProviderDeviceRuntimeScope(runtimes, task),
  };
}

function composeAppleRunnerProviderResolver(
  runtimes: ProviderDeviceRuntime[],
): AppleRunnerProviderResolver | undefined {
  if (!runtimes.some(hasAppleRunnerProvider)) return undefined;
  return (context) => {
    for (const runtime of runtimes) {
      if (!hasAppleRunnerProvider(runtime) || !runtime.ownsDevice(context.device)) continue;
      const provider = runtime.getAppleRunnerProvider(context.device);
      if (provider) return provider;
    }
    return undefined;
  };
}

function hasAppleRunnerProvider(
  runtime: ProviderDeviceRuntime,
): runtime is AppleRunnerRuntimeExtension {
  return (
    'getAppleRunnerProvider' in runtime && typeof runtime.getAppleRunnerProvider === 'function'
  );
}

function composeExpiredLeaseRecovery(
  runtimes: ProviderDeviceRuntime[],
): ProviderExpiredLeaseRecovery | undefined {
  if (!runtimes.some((runtime) => runtime.recoverExpiredLease !== undefined)) return undefined;
  return async (lease) => {
    const runtime = runtimes.find((candidate) =>
      runtimeMatchesProvider(candidate, lease.leaseProvider),
    );
    if (!runtime?.recoverExpiredLease) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        `Provider ${lease.leaseProvider ?? 'unknown'} cannot recover an expired lease.`,
        { provider: lease.leaseProvider, leaseId: lease.leaseId },
      );
    }
    await runtime.recoverExpiredLease(lease);
  };
}

function uniqueProviderIds(providerIds: readonly string[]): string[] {
  return [...new Set(providerIds)];
}

function composeLeaseProvider(
  runtimes: ProviderDeviceRuntime[],
): LeaseLifecycleProvider | undefined {
  if (runtimes.length === 0) return undefined;
  return {
    allocate: async (lease, context) =>
      await firstProviderResult(runtimes, 'allocate', lease, context),
    heartbeat: async (lease, context) =>
      await firstProviderResult(runtimes, 'heartbeat', lease, context),
    release: async (lease, context) =>
      await firstProviderResult(runtimes, 'release', lease, context),
  };
}

function composeCloudArtifactProvider(
  runtimes: ProviderDeviceRuntime[],
): CloudArtifactProvider | undefined {
  if (runtimes.length === 0) return undefined;
  return {
    listCloudArtifacts: async (query) => await firstCloudArtifactsResult(runtimes, query),
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

async function firstCloudArtifactsResult(
  runtimes: ProviderDeviceRuntime[],
  query: CloudArtifactsQuery,
): Promise<CloudArtifactsResult | undefined> {
  for (const runtime of runtimes) {
    if (!runtimeMatchesProvider(runtime, query.provider)) continue;
    const result = await runtime.cloudArtifacts?.listCloudArtifacts?.(query);
    if (result) return result;
  }
  return undefined;
}

async function firstProviderResult(
  runtimes: ProviderDeviceRuntime[],
  method: keyof LeaseLifecycleProvider,
  lease: DeviceLease,
  context?: LeaseLifecycleContext,
): Promise<Record<string, unknown> | undefined> {
  for (const runtime of runtimes) {
    if (!runtimeMatchesProvider(runtime, lease.leaseProvider)) continue;
    const handler = runtime.leaseLifecycle[method];
    const result = handler ? await handler(lease, context) : undefined;
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
    { provider: runtime.provider, deviceId: device.id, platform: publicPlatformString(device) },
  );
}
