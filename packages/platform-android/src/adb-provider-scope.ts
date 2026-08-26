import { AsyncLocalStorage } from 'node:async_hooks';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { withAdbFailureHints } from './adb-failure.ts';
import { requireAndroidAdbHost, type AndroidAdbCommandExecutorOverride } from './adb-host.ts';
import { createExecAndroidPortReverseProvider } from './adb-port-reverse.ts';
import { normalizeAndroidAdbProvider } from './adb-provider-normalization.ts';
import {
  normalizeAndroidAdbInstallOptions,
  type AndroidAdbExecutor,
  type AndroidAdbProvider,
  type AndroidAdbProviderScopeOptions,
  type AndroidAdbSpawner,
  type AndroidTextInjector,
  type AndroidTouchProvider,
  type ScopedAndroidAdbBackgroundTransport,
} from './adb-transport.ts';

// The request-scoped provider seam: withAndroidAdbProvider installs a provider for one device
// serial, and every resolver below answers from that scope — falling back to host adb through
// the injected port only where a local device makes that meaningful.

type AndroidAdbProviderScope = {
  provider: AndroidAdbProvider;
  serial: string;
};

const androidAdbProviderScope = new AsyncLocalStorage<AndroidAdbProviderScope>();

export function createDeviceAdbExecutor(device: DeviceInfo): AndroidAdbExecutor {
  return createSerialAdbExecutor(device.id);
}

function createSerialAdbExecutor(serial: string): AndroidAdbExecutor {
  return withAdbFailureHints(
    async (args, options) => await requireAndroidAdbHost().execSerialAdb(serial, args, options),
  );
}

function createSerialAdbSpawner(serial: string): AndroidAdbSpawner {
  return (args, options) => requireAndroidAdbHost().spawnSerialAdb(serial, args, options);
}

export function createLocalAndroidAdbProvider(device: DeviceInfo): AndroidAdbProvider {
  const exec = createDeviceAdbExecutor(device);
  return {
    exec,
    spawn: createSerialAdbSpawner(device.id),
    reverse: createExecAndroidPortReverseProvider(exec),
    pull: async (remotePath, localPath, options) =>
      await exec(['pull', remotePath, localPath], options),
    install: async (apkPath, options) => {
      const { installArgs, execOptions } = normalizeAndroidAdbInstallOptions(options);
      return await exec(['install', ...installArgs, apkPath], execOptions);
    },
  };
}

export function resolveAndroidAdbExecutor(
  device: DeviceInfo,
  executor?: AndroidAdbExecutor,
): AndroidAdbExecutor {
  const scoped = androidAdbProviderScope.getStore();
  if (executor) return executor;
  if (scoped?.serial === device.id) return scoped.provider.exec;
  return createDeviceAdbExecutor(device);
}

export function resolveAndroidAdbProvider(
  device: DeviceInfo,
  provider?: AndroidAdbProvider | AndroidAdbExecutor,
): AndroidAdbProvider {
  if (provider) return normalizeAndroidAdbProvider(provider);
  const scoped = androidAdbProviderScope.getStore();
  return scoped?.serial === device.id
    ? normalizeAndroidAdbProvider(scoped.provider)
    : createLocalAndroidAdbProvider(device);
}

/**
 * Returns only the request-scoped provider background transport for this device.
 * Unlike {@link resolveAndroidAdbProvider}, this never falls back to host adb: callers
 * use absence to keep provider-backed long-lived processes fail-closed.
 */
export function resolveScopedAndroidAdbBackgroundTransport(
  device: DeviceInfo,
): ScopedAndroidAdbBackgroundTransport {
  const scoped = androidAdbProviderScope.getStore();
  if (scoped?.serial !== device.id) return { mode: 'local' };
  return {
    mode: 'transport-composed',
    ...(scoped.provider.spawn ? { spawn: scoped.provider.spawn } : {}),
  };
}

export function resolveAndroidTextInjector(device: DeviceInfo): AndroidTextInjector | undefined {
  const scoped = androidAdbProviderScope.getStore();
  return scoped?.serial === device.id ? scoped.provider.text : undefined;
}

export function resolveAndroidTouchProvider(device: DeviceInfo): AndroidTouchProvider | undefined {
  const scoped = androidAdbProviderScope.getStore();
  return scoped?.serial === device.id && scoped.provider.touch ? scoped.provider : undefined;
}

/** Provider for the transfer funnels: explicit provider, then device scope, then bare scope. */
export function resolveAndroidAdbTransferProvider(
  device: DeviceInfo | undefined,
  provider: AndroidAdbProvider | AndroidAdbExecutor | undefined,
): AndroidAdbProvider | undefined {
  if (provider) return normalizeAndroidAdbProvider(provider);
  if (device) return resolveAndroidAdbProvider(device);
  const scoped = androidAdbProviderScope.getStore();
  if (scoped) return normalizeAndroidAdbProvider(scoped.provider);
  return undefined;
}

export async function withAndroidAdbProvider<T>(
  provider: AndroidAdbProvider | AndroidAdbExecutor | undefined,
  options: AndroidAdbProviderScopeOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!provider) return await fn();
  // Normalization wraps once at scope installation, so every consumer — the
  // command-executor override and direct resolveAndroidAdb* lookups — gets
  // classified failure hints on exec and the semantic provider methods alike.
  const enriched = normalizeAndroidAdbProvider(provider);
  const scope = { provider: enriched, serial: options.serial };
  const override = createAndroidCommandExecutorOverride(scope);
  return await androidAdbProviderScope.run(
    scope,
    async () => await requireAndroidAdbHost().withAdbCommandExecutorOverride(override, fn),
  );
}

function createAndroidCommandExecutorOverride(
  scope: AndroidAdbProviderScope,
): AndroidAdbCommandExecutorOverride {
  return (cmd, args, options) => {
    if (cmd !== 'adb') return undefined;
    const providerArgs = stripAdbSerialArgs(args, scope.serial);
    if (!providerArgs) return undefined;
    return requireAndroidAdbHost().withoutAdbCommandExecutorOverride(
      async () => await scope.provider.exec(providerArgs, options),
    );
  };
}

function stripAdbSerialArgs(args: string[], expectedSerial: string): string[] | undefined {
  // The provider scope only owns normalized device-scoped adb calls:
  // adb -s <serial> <command...>. Global commands
  // such as adb devices/version, calls for another serial, and host-preconfigured
  // invocations stay local.
  if (args[0] !== '-s' || !args[1]) return undefined;
  if (args[1] !== expectedSerial) return undefined;
  return args.slice(2);
}
