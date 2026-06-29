import { AsyncLocalStorage } from 'node:async_hooks';
import type { Readable, Writable } from 'node:stream';
import type { DeviceInfo } from '../../kernel/device.ts';
import {
  runCmd,
  runCmdBackground,
  withCommandExecutorOverride,
  withoutCommandExecutorOverride,
  type CommandExecutorOverride,
  type ExecBackgroundOptions,
  type ExecOptions,
  type ExecResult,
} from '../../utils/exec.ts';
import { AppError } from '../../kernel/errors.ts';

export type AndroidAdbExecutorOptions = Pick<
  ExecOptions,
  'allowFailure' | 'timeoutMs' | 'binaryStdout' | 'stdin' | 'signal'
>;

export type AndroidAdbExecutorResult = Pick<
  ExecResult,
  'exitCode' | 'stdout' | 'stderr' | 'stdoutBuffer'
>;

export type AndroidAdbProcess = {
  pid?: number;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
};

/**
 * Runs device-scoped adb arguments after the device serial has already been selected.
 * Implementations must be safe to call concurrently for one request.
 */
export type AndroidAdbExecutor = (
  args: string[],
  options?: AndroidAdbExecutorOptions,
) => Promise<AndroidAdbExecutorResult>;

export type AndroidAdbSpawner = (
  args: string[],
  options?: ExecBackgroundOptions,
) => AndroidAdbProcess;

export type AndroidPortReverseEndpoint = `tcp:${number}` | `localabstract:${string}`;

export type AndroidPortReverseMapping = {
  local: AndroidPortReverseEndpoint;
  remote: AndroidPortReverseEndpoint;
  ownerId?: string;
};

export type AndroidPortReverseOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type AndroidPortReverseProvider = {
  ensure(mapping: AndroidPortReverseMapping, options?: AndroidPortReverseOptions): Promise<void>;
  remove(local: AndroidPortReverseEndpoint, options?: AndroidPortReverseOptions): Promise<void>;
  removeAllOwned(ownerId: string, options?: AndroidPortReverseOptions): Promise<void>;
  list?(options?: AndroidPortReverseOptions): Promise<AndroidPortReverseMapping[]>;
};

export type AndroidAdbTransferOptions = AndroidAdbExecutorOptions;
export type AndroidAdbInstallOptions = AndroidAdbTransferOptions & {
  replace?: boolean;
  allowTestPackages?: boolean;
  allowDowngrade?: boolean;
  grantPermissions?: boolean;
};

export type AndroidAdbPuller = (
  remotePath: string,
  localPath: string,
  options?: AndroidAdbTransferOptions,
) => Promise<AndroidAdbExecutorResult>;

/**
 * Installs an APK path. Implementations are responsible for honoring semantic
 * install options such as replace/test/downgrade/grant-permissions.
 */
export type AndroidAdbInstaller = (
  apkPath: string,
  options?: AndroidAdbInstallOptions,
) => Promise<AndroidAdbExecutorResult>;

export type AndroidBundleInstaller = (
  bundlePath: string,
  options: { mode: string },
) => Promise<void>;

export type AndroidTextInputAction = 'type' | 'fill';

export type AndroidTextInjectionRequest = {
  action: AndroidTextInputAction;
  text: string;
  delayMs?: number;
  /**
   * Present only for fill. Providers must make this target the focused/replaced
   * input for the request, not inject into an unrelated currently focused field.
   */
  target?: {
    x: number;
    y: number;
  };
};

export type AndroidTextInjector = (request: AndroidTextInjectionRequest) => Promise<void>;

export type AndroidTouchGestureRequest =
  | {
      kind: 'swipe';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      durationMs?: number;
    }
  | {
      kind: 'pinch';
      x: number;
      y: number;
      scale: number;
      durationMs?: number;
    }
  | {
      kind: 'rotate';
      x: number;
      y: number;
      degrees: number;
      durationMs?: number;
    }
  | {
      kind: 'transform';
      x: number;
      y: number;
      dx: number;
      dy: number;
      scale: number;
      degrees: number;
      durationMs?: number;
    };

export type AndroidTouchInjector = (
  request: AndroidTouchGestureRequest,
) => Promise<Record<string, unknown> | void>;

export type AndroidAdbProvider = {
  /**
   * Fallback executor for device-scoped adb arguments. Providers may omit explicit
   * methods to keep the legacy exec-shaped pull/install fallback.
   */
  exec: AndroidAdbExecutor;
  spawn?: AndroidAdbSpawner;
  reverse?: AndroidPortReverseProvider;
  pull?: AndroidAdbPuller;
  install?: AndroidAdbInstaller;
  installBundle?: AndroidBundleInstaller;
  text?: AndroidTextInjector;
  touch?: AndroidTouchInjector;
};

export type AndroidAdbProviderScopeOptions = {
  serial: string;
};

type AndroidAdbProviderScope = {
  provider: AndroidAdbProvider;
  serial: string;
};

const androidAdbProviderScope = new AsyncLocalStorage<AndroidAdbProviderScope>();

export function createDeviceAdbExecutor(device: DeviceInfo): AndroidAdbExecutor {
  return createSerialAdbExecutor(device.id);
}

function createSerialAdbExecutor(serial: string): AndroidAdbExecutor {
  return async (args, options) =>
    // Local adb execution must escape any active provider scope to avoid routing
    // tunnel-backed providers back into themselves when they shell out to adb.
    await withoutCommandExecutorOverride(
      async () =>
        await runCmd('adb', ['-s', serial, ...args], {
          ...options,
          // Some `adb shell` children can survive killing the adb parent and keep
          // requests open past timeout. Give each adb call its own process group
          // so timeout/abort cleanup can tear down the whole local command tree.
          detached: process.platform !== 'win32',
        }),
    );
}

function createSerialAdbSpawner(serial: string): AndroidAdbSpawner {
  return (args, options) => {
    const background = runCmdBackground('adb', ['-s', serial, ...args], {
      ...options,
      allowFailure: true,
      captureOutput: false,
    });
    void background.wait.catch(() => {});
    return background.child;
  };
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

export function resolveAndroidTextInjector(device: DeviceInfo): AndroidTextInjector | undefined {
  const scoped = androidAdbProviderScope.getStore();
  return scoped?.serial === device.id ? scoped.provider.text : undefined;
}

export function resolveAndroidTouchInjector(device: DeviceInfo): AndroidTouchInjector | undefined {
  const scoped = androidAdbProviderScope.getStore();
  return scoped?.serial === device.id ? scoped.provider.touch : undefined;
}

export function createAndroidPortReverseManager(
  provider: AndroidAdbProvider | AndroidAdbExecutor,
): AndroidPortReverseProvider {
  const normalized = normalizeAndroidAdbProvider(provider);
  const reverse = normalized.reverse ?? createExecAndroidPortReverseProvider(normalized.exec);
  const active = new Map<AndroidPortReverseEndpoint, AndroidPortReverseMapping>();
  return {
    async ensure(mapping, options) {
      const current = active.get(mapping.local);
      if (current && current.ownerId !== mapping.ownerId) {
        throw new AppError(
          'COMMAND_FAILED',
          `Android port reverse ${mapping.local} is already owned by ${current.ownerId ?? 'another session'}`,
          { current, requested: mapping },
        );
      }
      if (current?.remote === mapping.remote) {
        return;
      }
      await reverse.ensure(mapping, options);
      active.set(mapping.local, { ...mapping });
    },
    async remove(local, options) {
      if (!active.has(local)) {
        await reverse.remove(local, options);
        return;
      }
      await reverse.remove(local, options);
      active.delete(local);
    },
    async removeAllOwned(ownerId, options) {
      const locals = [...active.values()]
        .filter((mapping) => mapping.ownerId === ownerId)
        .map((mapping) => mapping.local);
      if (locals.length === 0) {
        await reverse.removeAllOwned(ownerId, options);
        return;
      }
      for (const local of locals) {
        await reverse.remove(local, options);
        active.delete(local);
      }
    },
    async list(options) {
      return reverse.list ? await reverse.list(options) : [...active.values()];
    },
  };
}

function normalizeAndroidAdbProvider(
  provider: AndroidAdbProvider | AndroidAdbExecutor,
): AndroidAdbProvider {
  if (typeof provider === 'function') {
    return { exec: provider };
  }
  return provider;
}

type AndroidAdbTransferProviderOptions = {
  device?: DeviceInfo;
  provider?: AndroidAdbProvider | AndroidAdbExecutor;
};

export async function pullAndroidAdbFile(
  remotePath: string,
  localPath: string,
  options?: AndroidAdbTransferOptions & AndroidAdbTransferProviderOptions,
): Promise<AndroidAdbExecutorResult> {
  const { device, provider, ...transferOptions } = options ?? {};
  const resolved = resolveTransferProvider(device, provider);
  const pull = resolved?.pull;
  if (pull) {
    return await withoutCommandExecutorOverride(
      async () => await pull(remotePath, localPath, transferOptions),
    );
  }
  const exec = resolved?.exec;
  if (!exec) {
    throw new AppError('COMMAND_FAILED', 'Android adb pull requires an adb provider');
  }
  return await withoutCommandExecutorOverride(
    async () => await exec(['pull', remotePath, localPath], transferOptions),
  );
}

export async function installAndroidAdbPackage(
  apkPath: string,
  options?: AndroidAdbInstallOptions & AndroidAdbTransferProviderOptions,
): Promise<AndroidAdbExecutorResult> {
  const { device, provider, ...installOptions } = options ?? {};
  const resolved = resolveTransferProvider(device, provider);
  const install = resolved?.install;
  if (install) {
    return await withoutCommandExecutorOverride(async () => await install(apkPath, installOptions));
  }
  const exec = resolved?.exec;
  if (!exec) {
    throw new AppError('COMMAND_FAILED', 'Android adb install requires an adb provider');
  }
  const { installArgs, execOptions } = normalizeAndroidAdbInstallOptions(installOptions);
  return await withoutCommandExecutorOverride(
    async () => await exec(['install', ...installArgs, apkPath], execOptions),
  );
}

function resolveTransferProvider(
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
  const normalized = typeof provider === 'function' ? { exec: provider } : provider;
  const scope = { provider: normalized, serial: options.serial };
  const override = createAndroidCommandExecutorOverride(scope);
  return await androidAdbProviderScope.run(
    scope,
    async () => await withCommandExecutorOverride(override, fn),
  );
}

function createAndroidCommandExecutorOverride(
  scope: AndroidAdbProviderScope,
): CommandExecutorOverride {
  return (cmd, args, options) => {
    if (cmd !== 'adb') return undefined;
    const providerArgs = stripAdbSerialArgs(args, scope.serial);
    if (!providerArgs) return undefined;
    return withoutCommandExecutorOverride(
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

function createExecAndroidPortReverseProvider(adb: AndroidAdbExecutor): AndroidPortReverseProvider {
  const owned = new Map<string, Set<AndroidPortReverseEndpoint>>();
  return {
    async ensure(mapping, options) {
      await adb(['reverse', mapping.local, mapping.remote], {
        allowFailure: false,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
      if (mapping.ownerId) {
        const ownedLocals = owned.get(mapping.ownerId) ?? new Set<AndroidPortReverseEndpoint>();
        ownedLocals.add(mapping.local);
        owned.set(mapping.ownerId, ownedLocals);
      }
    },
    async remove(local, options) {
      const result = await adb(['reverse', '--remove', local], {
        allowFailure: true,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
      if (result.exitCode !== 0 && !isMissingReverseMapping(result.stdout, result.stderr)) {
        throw new Error(`Failed to remove Android port reverse ${local}: ${result.stderr}`);
      }
      for (const locals of owned.values()) {
        locals.delete(local);
      }
    },
    async removeAllOwned(ownerId, options) {
      const locals = [...(owned.get(ownerId) ?? [])];
      for (const local of locals) {
        await this.remove(local, options);
      }
      owned.delete(ownerId);
    },
    async list(options) {
      const result = await adb(['reverse', '--list'], {
        allowFailure: true,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
      if (result.exitCode !== 0) return [];
      return parseAndroidReverseList(result.stdout, owned);
    },
  };
}

function parseAndroidReverseList(
  stdout: string,
  owned: ReadonlyMap<string, ReadonlySet<AndroidPortReverseEndpoint>>,
): AndroidPortReverseMapping[] {
  const ownerByLocal = new Map<AndroidPortReverseEndpoint, string>();
  for (const [ownerId, locals] of owned) {
    for (const local of locals) {
      ownerByLocal.set(local, ownerId);
    }
  }
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string, string] => parts.length >= 3)
    .map(([, local, remote]) => {
      const localEndpoint = local as AndroidPortReverseEndpoint;
      return {
        local: localEndpoint,
        remote: remote as AndroidPortReverseEndpoint,
        ownerId: ownerByLocal.get(localEndpoint),
      };
    });
}

function isMissingReverseMapping(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return text.includes('listener') && text.includes('not found');
}

function normalizeAndroidAdbInstallOptions(options?: AndroidAdbInstallOptions): {
  installArgs: string[];
  execOptions: AndroidAdbTransferOptions;
} {
  const { replace, allowTestPackages, allowDowngrade, grantPermissions, ...execOptions } =
    options ?? {};
  const installArgs: string[] = [];
  if (replace) installArgs.push('-r');
  if (allowTestPackages) installArgs.push('-t');
  if (allowDowngrade) installArgs.push('-d');
  if (grantPermissions) installArgs.push('-g');
  return { installArgs, execOptions };
}
