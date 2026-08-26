import type {
  ProviderDeviceInventorySource,
  DeviceLease,
  LeaseLifecycleContext,
  LeaseLifecycleProvider,
  ProviderDeviceRuntime,
  ProviderExpiredLeaseRecovery,
} from '@agent-device/contracts/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type {
  CloudArtifactProvider,
  CloudArtifactsQuery,
  CloudArtifactsResult,
} from '@agent-device/contracts/observability';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AppleRunnerProviderResolver,
  AppleRunnerScreenRecordingTransportResolver,
} from './daemon/request-platform-providers.ts';
import type { AppleRunnerScreenRecordingTransport } from './platform-runtime-screen-recording-apple-runner-transport.ts';
import type {
  AppleRunnerCommandExecutor,
  AppleRunnerProvider,
} from '@agent-device/platform-apple/runner';

type AppleRunnerRuntimeExtension = ProviderDeviceRuntime & {
  getAppleRunnerProvider(
    device: DeviceInfo,
  ): AppleRunnerProvider | AppleRunnerCommandExecutor | undefined;
};

type AppleRunnerScreenRecordingRuntimeExtension = ProviderDeviceRuntime & {
  getAppleRunnerScreenRecordingTransport(
    device: DeviceInfo,
  ): AppleRunnerScreenRecordingTransport | undefined;
};

export type ProviderDeviceRuntimeRequestProviders = {
  /** Eager provider ownership metadata for the platform-runtime composition boundary. */
  providerRuntimes: readonly ProviderDeviceRuntime[];
  providerRuntimeIds: readonly string[];
  providerRuntimeRequiredIds: readonly string[];
  recoverableProviderIds: readonly string[];
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  recoverExpiredLease?: ProviderExpiredLeaseRecovery;
  cloudArtifactProvider?: CloudArtifactProvider;
  deviceInventorySource?: ProviderDeviceInventorySource;
  appleRunnerProvider?: AppleRunnerProviderResolver;
  appleRunnerScreenRecordingTransport?: AppleRunnerScreenRecordingTransportResolver;
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

function getActiveProviderDeviceRuntimes(): ProviderDeviceRuntime[] {
  return providerDeviceRuntimeScope.getStore() ?? activeProviderDeviceRuntimes;
}

export function createProviderDeviceRuntimeRequestProviders(
  runtimes: ProviderDeviceRuntime[],
  options: { providerRuntimeRequiredIds?: readonly string[] } = {},
): ProviderDeviceRuntimeRequestProviders {
  assertUniqueProviderRuntimeIds(runtimes);
  const providerRuntimeIds = runtimes.map((runtime) => runtime.provider);
  return {
    providerRuntimes: Object.freeze([...runtimes]),
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
    deviceInventorySource: composeDeviceInventorySource(runtimes),
    appleRunnerProvider: composeAppleRunnerProviderResolver(runtimes),
    appleRunnerScreenRecordingTransport:
      composeAppleRunnerScreenRecordingTransportResolver(runtimes),
    providerDeviceRuntimeScope: async (task) =>
      await withProviderDeviceRuntimeScope(runtimes, task),
  };
}

function composeAppleRunnerScreenRecordingTransportResolver(
  runtimes: ProviderDeviceRuntime[],
): AppleRunnerScreenRecordingTransportResolver | undefined {
  if (!runtimes.some(hasAppleRunnerScreenRecordingTransport)) return undefined;
  return (context) => {
    for (const runtime of runtimes) {
      if (!hasAppleRunnerScreenRecordingTransport(runtime) || !runtime.ownsDevice(context.device)) {
        continue;
      }
      const transport = runtime.getAppleRunnerScreenRecordingTransport(context.device);
      if (transport) return transport;
    }
    return undefined;
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

function hasAppleRunnerScreenRecordingTransport(
  runtime: ProviderDeviceRuntime,
): runtime is AppleRunnerScreenRecordingRuntimeExtension {
  return (
    'getAppleRunnerScreenRecordingTransport' in runtime &&
    typeof runtime.getAppleRunnerScreenRecordingTransport === 'function'
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

function composeDeviceInventorySource(
  runtimes: ProviderDeviceRuntime[],
): ProviderDeviceInventorySource | undefined {
  if (runtimes.length === 0) return undefined;
  return {
    discover: async (request, signal) => {
      signal.throwIfAborted();
      for (const runtime of runtimes) {
        if (!runtimeMatchesProvider(runtime, request.leaseProvider)) continue;
        const devices = await runtime.deviceInventoryProvider(request, signal);
        signal.throwIfAborted();
        if (devices !== null && devices !== undefined) {
          return { kind: 'inventory', devices };
        }
      }
      return { kind: 'declined' };
    },
  };
}

function assertUniqueProviderRuntimeIds(runtimes: readonly ProviderDeviceRuntime[]): void {
  const seen = new Set<string>();
  for (const runtime of runtimes) {
    if (seen.has(runtime.provider)) {
      throw new TypeError(`Duplicate provider device runtime: ${runtime.provider}`);
    }
    seen.add(runtime.provider);
  }
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
