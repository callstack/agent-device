import { AsyncLocalStorage } from 'node:async_hooks';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  assertDeviceShellArgv,
  deviceShellArgv,
  deviceShellExecutableOf,
  type ShellWord,
} from '@agent-device/kernel/device-shell';
import {
  androidAdbInvocation,
  androidAdbPayloadWithoutSerial,
  applyManagedAndroidAdbServer,
  normalizeAndroidAdbInstallOptions,
  parseAndroidAdbArgv,
  adoptAndroidAdbSerial,
  requireManagedAndroidAdbAddressing,
  requireManagedAndroidAdbSerial,
  requireSameAndroidAdbServer,
  requireUnconflictedAndroidAdbSelector,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
  type AndroidAdbInvocation,
  type AndroidAdbProvider,
  type AndroidAdbProviderScopeOptions,
  type AndroidAdbSelector,
  type AndroidAdbSpawner,
  type AndroidTextInjector,
  type AndroidTouchProvider,
  type ScopedAndroidAdbBackgroundTransport,
} from './adb-transport.ts';
import {
  requireAndroidAdbHost,
  withAndroidHostAdbTransport,
  type AndroidAdbCommandExecutorOverride,
  type AndroidAdbHostTransport,
} from './adb-host.ts';
import { withAdbFailureHints } from './adb-failure.ts';
import { createExecAndroidPortReverseProvider } from './adb-port-reverse.ts';
import { normalizeAndroidAdbProvider } from './adb-provider-normalization.ts';

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
  return guardDeviceShell(createSerialAdbExecutor(device.id, options.serverPort));
}

function createSerialAdbExecutor(serial: string, serverPort?: number): AndroidAdbExecutor {
  return withAdbFailureHints(async (args, options) => {
    const request = deviceAdbRouteRequest(serial, serverPort, args, options);
    // A device-scoped executor is the terminal local route: an installed provider must not
    // capture it and route the call back into itself.
    return await requireAndroidAdbHost().withoutAdbCommandExecutorOverride(
      async () => await requireAndroidAdbHost().execAdb(request.invocation, request.options),
    );
  });
}

function createSerialAdbSpawner(serial: string, serverPort?: number): AndroidAdbSpawner {
  return guardDeviceShellSpawn((args, options) => {
    const request = deviceAdbRouteRequest(serial, serverPort, args, options);
    return requireAndroidAdbHost().spawnAdb(request.invocation, request.options);
  });
}

/** One device-scoped request: addressing decided once, and the server's option channel removed. */
function deviceAdbRouteRequest<Options extends { serverPort?: number }>(
  serial: string,
  installed: number | undefined,
  args: readonly string[],
  options: Options | undefined,
): { invocation: AndroidAdbInvocation; options: Omit<Options, 'serverPort'> } {
  const { serverPort: requested, ...rest } = options ?? ({} as Options);
  return {
    invocation: androidDeviceAdbInvocation(
      serial,
      args,
      deviceServerPort(serial, installed, requested),
    ),
    options: rest,
  };
}

/**
 * Addresses `args` for `serial`, carrying the chosen adb server on the target and nowhere else. A
 * managed transport re-reads the argv through the shared managed rules, so the payload it spawns
 * is the parsed command by reference. A caller-chosen server rewrites addressing too, and an
 * ambient transport keeps the caller's argv as the emitted form, because ambient adb lets a later
 * `-s` win.
 */
function androidDeviceAdbInvocation(
  serial: string,
  args: readonly string[],
  port: number | undefined,
): AndroidAdbInvocation {
  const parsed = parseAndroidAdbArgv(args);
  const selector = adoptAndroidAdbSerial(parsed.target, serial);
  if (port === undefined) {
    return androidAdbInvocation(selector, parsed.command, ['-s', serial, ...args]);
  }
  // A private adb server makes this a managed transport, whoever named the port: the rules over
  // what such a transport may be asked for are the same ones the lease is held to.
  const managed = applyManagedAndroidAdbServer(parsed, { port });
  return androidAdbInvocation(
    requireManagedAndroidAdbSerial(managed.target, serial),
    managed.command,
  );
}

/**
 * The adb server a device-scoped route runs against, from the one channel that may name it.
 *
 * Under a lease that is the lease's private server and nothing else: a route constructed for
 * another port, or a call asking for one, is refused rather than followed. Without a lease the
 * owner's port wins over a per-call request, which is what the route was built to answer for.
 */
function deviceServerPort(
  serial: string,
  installed: number | undefined,
  requested: number | undefined,
): number | undefined {
  const scope = androidAdbProviderScope.getStore();
  if (scope) requireScopedSerial(scope, { kind: 'serial', serial });
  if (scope?.serverPort !== undefined) {
    // A lease's server is the only one this route may answer for; naming another, at construction
    // or per call, is refused rather than followed.
    requireSameAndroidAdbServer(installed, scope.serverPort);
    return requireSameAndroidAdbServer(requested, scope.serverPort);
  }
  return installed ?? requested;
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
  const scoped = scopeForDevice(device);
  if (executor) return guardDeviceShell(executor);
  if (scoped?.serial === device.id) return guardDeviceShell(scoped.provider.exec);
  return createDeviceAdbExecutor(device);
}

export function resolveAndroidAdbProvider(
  device: DeviceInfo,
  provider?: AndroidAdbProvider | AndroidAdbExecutor,
): AndroidAdbProvider {
  const scoped = scopeForDevice(device);
  if (provider) return guardProviderDeviceShell(normalizeAndroidAdbProvider(provider));
  return guardProviderDeviceShell(
    scoped?.serial === device.id
      ? normalizeAndroidAdbProvider(scoped.provider)
      : createLocalAndroidAdbProvider(device),
  );
}

/**
 * Returns only the request-scoped provider background transport for this device.
 * Unlike {@link resolveAndroidAdbProvider}, this never falls back to host adb: callers
 * use absence to keep provider-backed long-lived processes fail-closed.
 */
export function resolveScopedAndroidAdbBackgroundTransport(
  device: DeviceInfo,
): ScopedAndroidAdbBackgroundTransport {
  const scoped = scopeForDevice(device);
  if (scoped?.serial !== device.id) return { mode: 'local' };
  return {
    mode: 'transport-composed',
    ...(scoped.provider.spawn ? { spawn: guardDeviceShellSpawn(scoped.provider.spawn) } : {}),
  };
}

export function resolveAndroidTextInjector(device: DeviceInfo): AndroidTextInjector | undefined {
  const scoped = scopeForDevice(device);
  return scoped?.serial === device.id ? scoped.provider.text : undefined;
}

export function resolveAndroidTouchProvider(device: DeviceInfo): AndroidTouchProvider | undefined {
  const scoped = scopeForDevice(device);
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
  return await withAndroidHostAdbTransport(
    createScopedHostTransport(scope, options.serverPort),
    run,
  );
}

function createAndroidCommandExecutorOverride(
  scope: AndroidAdbProviderScope,
): AndroidAdbCommandExecutorOverride {
  return (cmd, args, options) => {
    if (!isAdbCommand(cmd)) return undefined;
    if (scope.serverPort === undefined && cmd !== 'adb') return undefined;
    const invocation = parseAndroidAdbArgv(args);
    requireScopedSerial(scope, invocation.target.selector);
    if (invocation.target.selector.kind === 'serial') {
      if (invocation.target.selector.serial !== scope.serial) return undefined;
      // Under a private adb server the provider cannot restate a caller's host globals, and a
      // `-P` naming another server would reach adb through a provider that never sees addressing,
      // so both are refused here. Without a lease the caller's own adb invocation is what runs, as
      // it always has.
      if (scope.serverPort !== undefined) {
        requireManagedAndroidAdbAddressing(invocation.target, scope.serverPort);
      }
      // The provider contract is argv-shaped, so it receives the caller's request with this
      // scope's own `-s` pair removed — readiness tokens and transport globals left where the
      // caller put them, and never a rebuild with the scope's serial stitched back in.
      const payload = androidAdbPayloadWithoutSerial(args, scope.serial);
      if (payload === undefined) return undefined;
      return requireAndroidAdbHost().withoutAdbCommandExecutorOverride(
        async () => await scope.provider.exec(payload, options),
      );
    }
    const port = scope.serverPort;
    if (port === undefined) return undefined;
    return execOnScopedTransport(scope, port, invocation, options);
  };
}

function createScopedHostTransport(
  scope: AndroidAdbProviderScope,
  port: number,
): AndroidAdbHostTransport {
  return async (invocation, options) => {
    requireScopedSerial(scope, invocation.target.selector);
    return execOnScopedTransport(scope, port, invocation, options);
  };
}

/**
 * Answers one request on the lease's own transport: the scope's serial, and its server carried in
 * the addressing rather than in the options, which is what leaves a caller no second way to name
 * another adb server. A call that names one anyway is refused, not quietly restated.
 */
async function execOnScopedTransport(
  scope: AndroidAdbProviderScope,
  port: number,
  invocation: AndroidAdbInvocation,
  options: AndroidAdbExecutorOptions | undefined,
): Promise<AndroidAdbExecutorResult> {
  requireSameAndroidAdbServer(port, options?.serverPort);
  const { serverPort: _omitted, ...rest } = options ?? {};
  const serialTarget = requireManagedAndroidAdbSerial(invocation.target, scope.serial);
  const scoped = applyManagedAndroidAdbServer(
    androidAdbInvocation(serialTarget, invocation.command),
    { port },
  );
  const host = requireAndroidAdbHost();
  return await host.withoutAdbCommandExecutorOverride(
    async () => await host.execAdb(scoped, { ...rest, allowFailure: true }),
  );
}

function scopeForDevice(device: DeviceInfo): AndroidAdbProviderScope | undefined {
  const scoped = androidAdbProviderScope.getStore();
  if (scoped) requireScopedSerial(scoped, { kind: 'serial', serial: device.id });
  return scoped;
}

/** Under a private server, a request that names another device is not this scope's to answer. */
function requireScopedSerial(
  scope: AndroidAdbProviderScope | undefined,
  selector: AndroidAdbSelector,
): void {
  if (scope?.serverPort === undefined) return;
  requireUnconflictedAndroidAdbSelector(selector, scope.serial);
}

function isAdbCommand(command: string): boolean {
  return deviceShellExecutableOf(command) === 'adb';
}

/** Runs `adb shell <words>` through an executor; every word is quoted for the device shell. */
export async function runAdbShell(
  adb: AndroidAdbExecutor,
  words: readonly ShellWord[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await adb(deviceShellArgv('adb', 'shell', words), options);
}

/** Runs `adb exec-out <words>` (raw stdout) through an executor. */
export async function runAdbExecOut(
  adb: AndroidAdbExecutor,
  words: readonly ShellWord[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await adb(deviceShellArgv('adb', 'exec-out', words), options);
}

/** Every adb entry point the cluster hands out refuses a device-shell command the funnel skipped. */
function guardDeviceShell(executor: AndroidAdbExecutor): AndroidAdbExecutor {
  return async (args, options) => {
    assertDeviceShellArgv(args, 'adb');
    return await executor(args, options);
  };
}

function guardDeviceShellSpawn(spawn: AndroidAdbSpawner): AndroidAdbSpawner {
  return (args, options) => {
    assertDeviceShellArgv(args, 'adb');
    return spawn(args, options);
  };
}

/** A provider's exec and spawn are adb boundaries just like the local route's. */
function guardProviderDeviceShell<Provider extends AndroidAdbProvider>(
  provider: Provider,
): Provider {
  return {
    ...provider,
    exec: guardDeviceShell(provider.exec),
    ...(provider.spawn ? { spawn: guardDeviceShellSpawn(provider.spawn) } : {}),
  };
}
