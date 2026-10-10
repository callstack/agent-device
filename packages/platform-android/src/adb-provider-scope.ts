import { AsyncLocalStorage } from 'node:async_hooks';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  assertDeviceShellArgv,
  deviceShellArgv,
  type ShellWord,
} from '@agent-device/kernel/device-shell';
import { AppError } from '@agent-device/kernel/errors';
import {
  androidAdbInvocation,
  androidAdbPayloadWithoutSerial,
  applyManagedAndroidAdbServer,
  normalizeAndroidAdbInstallOptions,
  parseAndroidAdbArgv,
  adoptAndroidAdbSerial,
  requireManagedAndroidAdbSerial,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
  type AndroidAdbInvocation,
  type AndroidAdbProvider,
  type AndroidAdbProviderScopeOptions,
  type AndroidAdbSpawner,
  type AndroidTextInjector,
  type AndroidTouchProvider,
  type ScopedAndroidAdbBackgroundTransport,
} from './adb-transport.ts';
import { requireAndroidAdbHost, type AndroidAdbCommandExecutorOverride } from './adb-host.ts';
import {
  attachAdbFailureHint,
  classifyAndroidAdbFailure,
  withAdbFailureHints,
} from './adb-failure.ts';
import { createExecAndroidPortReverseProvider } from './adb-port-reverse.ts';
import { normalizeAndroidAdbProvider } from './adb-provider-normalization.ts';

// The request-scoped provider seam: withAndroidAdbProvider installs a provider for one device
// serial, and every resolver below answers from that scope — falling back to host adb through
// the injected port only where a local device makes that meaningful.

type AndroidAdbProviderScope = {
  provider: AndroidAdbProvider;
  serial: string;
};

const androidAdbProviderScope = new AsyncLocalStorage<AndroidAdbProviderScope>();

export function createDeviceAdbExecutor(device: DeviceInfo): AndroidAdbExecutor {
  return guardDeviceShell(createSerialAdbExecutor(device.id));
}

function createSerialAdbExecutor(serial: string): AndroidAdbExecutor {
  return withAdbFailureHints(async (args, options) => {
    const host = requireAndroidAdbHost();
    const exec = async (
      argv: readonly string[],
      execOptions: AndroidAdbExecutorOptions | undefined,
    ): Promise<AndroidAdbExecutorResult> => {
      const request = deviceAdbRouteRequest(serial, argv, execOptions);
      // A device-scoped executor is the terminal local route: an installed provider must not
      // capture it and route the call back into itself.
      return await host.withoutAdbCommandExecutorOverride(
        async () => await host.execAdb(request.invocation, request.options),
      );
    };
    return await retryOnceAfterDeviceOffline(
      `${options?.serverPort ?? ''}/${serial}`,
      options,
      async (attemptOptions) => await exec(args, attemptOptions),
      async (timeoutMs) => {
        await exec(['wait-for-device'], {
          allowFailure: true,
          timeoutMs,
          signal: options?.signal,
          env: options?.env,
          serverPort: options?.serverPort,
        }).catch(() => undefined);
      },
    );
  });
}

/** Devices, keyed by adb server and serial, that stayed offline through a wait for the device. */
export type StayedOfflineDevices = Readonly<{
  /** Whether the device's refusals still surface without another wait. */
  has(device: string): boolean;
  /** Records that the device stayed offline, and drops every mark that has lapsed. */
  mark(device: string): void;
  forget(device: string): void;
}>;

export function createStayedOfflineDevices(
  windowMs: number,
  expiries = new Map<string, number>(),
): StayedOfflineDevices {
  return {
    has: (device) => (expiries.get(device) ?? 0) > Date.now(),
    mark: (device) => {
      const now = Date.now();
      for (const [key, expiresAt] of expiries) {
        if (expiresAt <= now) expiries.delete(key);
      }
      expiries.set(device, now + windowMs);
    },
    forget: (device) => {
      expiries.delete(device);
    },
  };
}

/**
 * The longest a command refused as `device offline` waits for the device before its one retry. An
 * emulator drops to offline for a few seconds after boot while its adbd restarts.
 */
const ANDROID_DEVICE_OFFLINE_WAIT_MS = 15_000;

/** A device that stayed offline through a wait has its refusals surface without another for 30 s. */
const devicesStayingOffline = createStayedOfflineDevices(30_000);

/**
 * Runs `run`, and once more after `waitForDevice` when the host adb refused it as `device offline`.
 * The refusal comes before the command reaches the device, so the retry cannot repeat an effect.
 * The wait and the retry stay inside the caller's `timeoutMs`, the wait taking at most half of what
 * is left; with no budget left the refusal stands. A failed wait is not reported: the retry's
 * outcome is the device's state. A device that stayed offline through its wait fails fast for a
 * while instead of making every call wait.
 */
async function retryOnceAfterDeviceOffline(
  device: string,
  options: AndroidAdbExecutorOptions | undefined,
  run: (options: AndroidAdbExecutorOptions | undefined) => Promise<AndroidAdbExecutorResult>,
  waitForDevice: (timeoutMs: number) => Promise<void>,
): Promise<AndroidAdbExecutorResult> {
  const startedAt = Date.now();
  const first = await attemptAdb(device, async () => await run(options));
  if (!first.offline || devicesStayingOffline.has(device)) {
    return first.outcome();
  }
  const budgetMs = options?.timeoutMs;
  const remainingMs = () =>
    budgetMs === undefined ? Infinity : Math.floor(budgetMs - (Date.now() - startedAt));
  const waitMs = Math.min(ANDROID_DEVICE_OFFLINE_WAIT_MS, Math.floor(remainingMs() / 2));
  if (waitMs < 1) return first.outcome();
  await waitForDevice(waitMs);
  options?.signal?.throwIfAborted();
  const retryMs = remainingMs();
  if (retryMs < 1) return first.outcome();
  const retry = await attemptAdb(
    device,
    async () => await run(budgetMs === undefined ? options : { ...options, timeoutMs: retryMs }),
  );
  if (retry.offline) {
    devicesStayingOffline.mark(device);
  }
  return retry.outcome();
}

/**
 * Runs one adb attempt and reports whether the host adb refused it as `device offline`. An outcome
 * the device answered forgets that the device stayed offline; a timeout or cancellation does not.
 */
async function attemptAdb(
  device: string,
  run: () => Promise<AndroidAdbExecutorResult>,
): Promise<{ offline: boolean; outcome: () => AndroidAdbExecutorResult }> {
  try {
    const result = await run();
    const offline = isOfflineRefusalResult(result);
    if (!offline) devicesStayingOffline.forget(device);
    return { offline, outcome: () => result };
  } catch (error) {
    const classified = attachAdbFailureHint(error);
    const offline = isOfflineRefusalError(classified);
    if (!offline && deviceAnswered(classified)) devicesStayingOffline.forget(device);
    return {
      offline,
      outcome: () => {
        throw classified;
      },
    };
  }
}

/** Whether the host adb refused the command for an offline device, as a result. */
function isOfflineRefusalResult(result: AndroidAdbExecutorResult): boolean {
  if (result.exitCode === 0) return false;
  const failure = classifyAndroidAdbFailure(result.stderr, result.stdout);
  return isDeviceOfflineHostRefusal(failure?.reason, failure?.hostRefusal);
}

/** Whether the host adb refused the command for an offline device, as a classified thrown error. */
function isOfflineRefusalError(classified: unknown): boolean {
  if (!(classified instanceof AppError)) return false;
  return isDeviceOfflineHostRefusal(
    classified.details?.adbFailure,
    classified.details?.adbHostRefusal,
  );
}

/** Whether a classified adb failure is the host adb refusing a command for an offline device. */
function isDeviceOfflineHostRefusal(reason: unknown, hostRefusal: unknown): boolean {
  return reason === 'device_offline' && hostRefusal === true;
}

/** Whether a thrown adb failure is an exit the device reached, not a timeout or cancellation. */
function deviceAnswered(error: unknown): boolean {
  if (!(error instanceof AppError) || error.details?.timeoutMs !== undefined) return false;
  const exitCode = error.details?.exitCode;
  return typeof exitCode === 'number' && exitCode >= 0;
}

function createSerialAdbSpawner(serial: string): AndroidAdbSpawner {
  return guardDeviceShellSpawn((args, options) => {
    const request = deviceAdbRouteRequest(serial, args, options);
    return requireAndroidAdbHost().spawnAdb(request.invocation, request.options);
  });
}

/** One device-scoped request: addressing decided once, and the server's option channel removed. */
function deviceAdbRouteRequest<Options extends { serverPort?: number }>(
  serial: string,
  args: readonly string[],
  options: Options | undefined,
): { invocation: AndroidAdbInvocation; options: Omit<Options, 'serverPort'> } {
  const { serverPort, ...rest } = options ?? ({} as Options);
  return { invocation: androidDeviceAdbInvocation(serial, args, serverPort), options: rest };
}

/**
 * Addresses `args` for `serial`, carrying the per-call adb server on the target and nowhere else.
 * A private server re-reads the argv through the shared private-server rules, so the payload it
 * spawns is the parsed command by reference. An ambient transport keeps the caller's argv as the
 * emitted form, because ambient adb lets a later `-s` win.
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
  const managed = applyManagedAndroidAdbServer(parsed, { port });
  return androidAdbInvocation(
    requireManagedAndroidAdbSerial(managed.target, serial),
    managed.command,
  );
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
  if (executor) return guardDeviceShell(executor);
  if (scoped?.serial === device.id) return guardDeviceShell(scoped.provider.exec);
  return createDeviceAdbExecutor(device);
}

export function resolveAndroidAdbProvider(
  device: DeviceInfo,
  provider?: AndroidAdbProvider | AndroidAdbExecutor,
): AndroidAdbProvider {
  const scoped = androidAdbProviderScope.getStore();
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
  const scoped = androidAdbProviderScope.getStore();
  if (scoped?.serial !== device.id) return { mode: 'local' };
  return {
    mode: 'transport-composed',
    ...(scoped.provider.spawn ? { spawn: guardDeviceShellSpawn(scoped.provider.spawn) } : {}),
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
  const exec = guardDeviceShell(scope.provider.exec);
  return (cmd, args, options) => {
    if (cmd !== 'adb') return undefined;
    // The provider contract is argv-shaped, so it receives the caller's request with this
    // scope's own `-s` pair removed — readiness tokens and transport globals left where the
    // caller put them, and never a rebuild with the scope's serial stitched back in.
    const payload = androidAdbPayloadWithoutSerial(args, scope.serial);
    if (payload === undefined) return undefined;
    return requireAndroidAdbHost().withoutAdbCommandExecutorOverride(
      async () => await exec(payload, options),
    );
  };
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
