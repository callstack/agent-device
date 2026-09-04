import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  requireAndroidAdbHost,
  withAndroidHostAdbTransport,
  type AndroidAdbCommandExecutorOverride,
  type AndroidAdbHostTransport,
} from './adb-host.ts';
import { withAdbFailureHints } from './adb-failure.ts';
import { createExecAndroidPortReverseProvider } from './adb-port-reverse.ts';
import { normalizeAndroidAdbProvider } from './adb-provider-normalization.ts';
import {
  normalizeAndroidAdbInstallOptions,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
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
  serverPort?: number;
};

const androidAdbProviderScope = new AsyncLocalStorage<AndroidAdbProviderScope>();

export function createDeviceAdbExecutor(
  device: DeviceInfo,
  options: Readonly<{ serverPort?: number }> = {},
): AndroidAdbExecutor {
  return createSerialAdbExecutor(device.id, options.serverPort);
}

function createSerialAdbExecutor(serial: string, serverPort?: number): AndroidAdbExecutor {
  return withAdbFailureHints(
    async (args, options) =>
      await requireAndroidAdbHost().execSerialAdb(
        serial,
        args,
        serverPort === undefined ? options : { ...options, serverPort },
      ),
  );
}

function createSerialAdbSpawner(serial: string, serverPort?: number): AndroidAdbSpawner {
  return (args, options) =>
    requireAndroidAdbHost().spawnSerialAdb(
      serial,
      args,
      serverPort === undefined ? options : { ...options, serverPort },
    );
}

export function createLocalAndroidAdbProvider(
  device: DeviceInfo,
  options: Readonly<{ serverPort?: number }> = {},
): AndroidAdbProvider {
  const exec = createDeviceAdbExecutor(device, options);
  return {
    exec,
    spawn: createSerialAdbSpawner(device.id, options.serverPort),
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
  const scope = {
    provider: enriched,
    serial: options.serial,
    ...(options.serverPort === undefined ? {} : { serverPort: options.serverPort }),
  };
  const override = createAndroidCommandExecutorOverride(scope);
  const run = async () =>
    await androidAdbProviderScope.run(
      scope,
      async () => await requireAndroidAdbHost().withAdbCommandExecutorOverride(override, fn),
    );
  if (options.serverPort === undefined) return await run();
  return await withAndroidHostAdbTransport(createScopedHostTransport(scope), run);
}

function createAndroidCommandExecutorOverride(
  scope: AndroidAdbProviderScope,
): AndroidAdbCommandExecutorOverride {
  return (cmd, args, options) => {
    if (!isAdbCommand(cmd)) return undefined;
    if (scope.serverPort === undefined && cmd !== 'adb') return undefined;
    const serial = readAdbSerial(args);
    if (serial && serial !== scope.serial) return undefined;
    if (serial === scope.serial) {
      const providerArgs = stripAdbSerialArgs(args, scope.serial);
      if (!providerArgs) return undefined;
      return requireAndroidAdbHost().withoutAdbCommandExecutorOverride(
        async () => await scope.provider.exec(providerArgs, options),
      );
    }
    if (scope.serverPort === undefined) return undefined;
    return requireAndroidAdbHost().withoutAdbCommandExecutorOverride(
      async () =>
        await requireAndroidAdbHost().execHostAdb(args, {
          ...options,
          allowFailure: true,
          serverPort: scope.serverPort,
        }),
    );
  };
}

function createScopedHostTransport(scope: AndroidAdbProviderScope): AndroidAdbHostTransport {
  return async (args: string[], options?: AndroidAdbExecutorOptions) => {
    const serial = readAdbSerial(args);
    const host = requireAndroidAdbHost();
    return await host.withoutAdbCommandExecutorOverride(
      async () =>
        await host.execHostAdb(args, {
          ...options,
          allowFailure: true,
          ...(serial && serial !== scope.serial ? {} : { serverPort: scope.serverPort }),
        }),
    );
  };
}

function isAdbCommand(command: string): boolean {
  const executable = path.basename(command).replace(/\.(?:com|exe|bat|cmd)$/i, '');
  return executable === 'adb';
}

function readAdbSerial(args: readonly string[]): string | undefined {
  const serialIndex = findAdbSerialIndex(args);
  return serialIndex === undefined ? undefined : args[serialIndex + 1];
}

function findAdbSerialIndex(args: readonly string[]): number | undefined {
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === '-s') return index;
    if (argument === '-P' || argument === '-H' || argument === '-L') {
      index += 2;
      continue;
    }
    if (argument === '-a' || argument === '-d' || argument === '-e') {
      index += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function stripAdbSerialArgs(args: string[], expectedSerial: string): string[] | undefined {
  // The provider scope only owns normalized device-scoped adb calls:
  // adb -s <serial> <command...>. Global commands
  // such as adb devices/version, calls for another serial, and host-preconfigured
  // invocations stay local.
  const serialIndex = findAdbSerialIndex(args);
  if (serialIndex === undefined || args[serialIndex + 1] !== expectedSerial) return undefined;
  return [...args.slice(0, serialIndex), ...args.slice(serialIndex + 2)];
}
