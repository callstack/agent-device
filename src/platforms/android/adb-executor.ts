import { AsyncLocalStorage } from 'node:async_hooks';
import type { Readable, Writable } from 'node:stream';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { Rect } from '../../kernel/snapshot.ts';
import type { AndroidSnapshotHelperArtifact } from './snapshot-helper-types.ts';
import type { AndroidProviderTouchPlan } from './touch-plan.ts';
import {
  coerceExecResult,
  execFailureDetails,
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

export type AndroidTouchInjector = (
  request: AndroidProviderTouchPlan,
) => Promise<Record<string, unknown> | void>;

export type AndroidGestureViewportProvider = () => Promise<Rect>;

type AndroidAdbProviderBase = {
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
  snapshotHelperArtifact?: AndroidSnapshotHelperArtifact;
};

type AndroidTouchCapabilities =
  | {
      touch?: never;
      gestureViewport?: never;
    }
  | {
      touch: AndroidTouchInjector;
      gestureViewport: AndroidGestureViewportProvider;
    };

export type AndroidTouchProvider = Required<
  Pick<AndroidTouchCapabilities, 'touch' | 'gestureViewport'>
>;

export type AndroidAdbProvider = AndroidAdbProviderBase & AndroidTouchCapabilities;

export type AndroidAdbProviderScopeOptions = {
  serial: string;
};

type AndroidAdbProviderScope = {
  provider: AndroidAdbProvider;
  serial: string;
};

const androidAdbProviderScope = new AsyncLocalStorage<AndroidAdbProviderScope>();

export type AdbFailureClassification = {
  /** Machine-readable failure family, attached to error details as `adbFailure`. */
  reason:
    | 'timeout'
    | 'device_offline'
    | 'device_unauthorized'
    | 'device_not_found'
    | 'multiple_devices'
    | 'no_devices'
    | 'connection_dropped'
    | 'server_version_mismatch'
    | 'install_insufficient_storage'
    | 'install_update_incompatible'
    | 'install_version_downgrade'
    | 'install_failed';
  hint: string;
  /** Set only for clearly transient families where an unchanged retry can succeed. */
  retriable?: boolean;
};

type AdbFailureMatcher = AdbFailureClassification & {
  /** Tested against lowercased output. */
  pattern: RegExp;
  /**
   * Install verdicts often land on stdout (`Failure [INSTALL_FAILED_*]` from pm),
   * so those matchers also scan stdout. Everything else is stderr-only to avoid
   * misreading arbitrary `adb shell` output as a transport failure.
   */
  matchStdout?: boolean;
};

// Ordered most-specific first; the first match wins.
const ADB_FAILURE_MATCHERS: readonly AdbFailureMatcher[] = [
  {
    reason: 'device_unauthorized',
    pattern: /device unauthorized|device still authorizing/,
    hint: 'USB debugging is not authorized — accept the authorization prompt on the device screen (re-plug the cable if none appears), then retry.',
  },
  {
    reason: 'device_offline',
    pattern: /device offline/,
    hint: 'The device is connected but offline — wait for it to finish booting or run adb reconnect, then retry.',
    retriable: true,
  },
  {
    reason: 'multiple_devices',
    pattern: /more than one (?:device\/emulator|device and emulator)/,
    hint: 'Multiple Android devices are connected — pass --serial <serial> (see adb devices) to select one.',
  },
  {
    reason: 'no_devices',
    pattern: /no devices\/emulators found|no devices found/,
    hint: 'No Android devices detected — boot an emulator or connect a device and verify it appears in adb devices.',
  },
  {
    reason: 'device_not_found',
    pattern: /device (?:'[^']*' )?not found/,
    hint: 'The device disconnected or is restarting — verify it is listed in adb devices, then retry.',
    retriable: true,
  },
  {
    reason: 'server_version_mismatch',
    pattern: /adb server version \(\d+\) doesn't match this client/,
    hint: 'Multiple adb installs conflict — adb restarts its server automatically, so retry; align PATH to a single adb to stop recurrences.',
    retriable: true,
  },
  {
    reason: 'connection_dropped',
    pattern: /transport error|connection reset|broken pipe|protocol fault/,
    hint: 'The adb connection dropped — retry; if it persists, run adb kill-server and reconnect the device.',
    retriable: true,
  },
  {
    reason: 'install_insufficient_storage',
    pattern: /install_failed_insufficient_storage/,
    hint: 'The device is out of storage — free up space or uninstall unused apps, then retry the install.',
    matchStdout: true,
  },
  {
    reason: 'install_update_incompatible',
    pattern: /install_failed_update_incompatible/,
    hint: 'The installed app has an incompatible signature — uninstall the existing app first, then retry the install.',
    matchStdout: true,
  },
  {
    reason: 'install_version_downgrade',
    pattern: /install_failed_version_downgrade/,
    hint: 'The APK is older than the installed app — uninstall the app first (or install with downgrade allowed), then retry.',
    matchStdout: true,
  },
  {
    reason: 'install_failed',
    pattern: /install_failed_\w+|install_parse_failed_\w+/,
    hint: 'The Android package installer rejected the APK — see the INSTALL_FAILED code in the error output for the exact cause.',
    matchStdout: true,
  },
];

// A timed-out adb invocation leaves no failure output to key on — the exec
// layer kills the process and rejects with COMMAND_FAILED carrying `timeoutMs`
// in details (see createTimeoutError in utils/exec.ts), so timeouts classify on
// that structured signal instead of a stderr matcher. Not marked retriable: an
// unchanged retry against a wedged adb server times out identically.
const ADB_TIMEOUT_CLASSIFICATION: AdbFailureClassification = {
  reason: 'timeout',
  hint: 'adb timed out — the adb server may be wedged. Run adb kill-server && adb start-server, check adb devices, then retry.',
};

/**
 * Maps well-known adb failure output to an actionable hint (and a `retriable`
 * flag for clearly transient families). Matches stderr; install verdicts also
 * match stdout. Returns undefined for unrecognized output.
 */
export function classifyAdbFailure(
  stderr: string,
  stdout = '',
): AdbFailureClassification | undefined {
  const stderrText = stderr.toLowerCase();
  const stdoutText = stdout.toLowerCase();
  for (const { pattern, matchStdout, ...classification } of ADB_FAILURE_MATCHERS) {
    if (pattern.test(stderrText) || (matchStdout && pattern.test(stdoutText))) {
      return classification;
    }
  }
  return undefined;
}

/**
 * Enriches a failed adb command error in place with the classified hint,
 * `retriable` flag, and machine-readable `adbFailure` family, so every adb call
 * site surfaces guidance without per-site classification. Exec-layer timeouts
 * classify as `timeout` even though they leave no stderr. No-op for errors that
 * are not adb command failures or that carry no recognized failure signal; an
 * existing hint or retriable verdict is never overwritten.
 */
export function attachAdbFailureHint<T>(error: T): T {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') return error;
  const classification = classifyAdbCommandError(error);
  if (!classification) return error;
  error.details = {
    ...error.details,
    adbFailure: classification.reason,
    ...(typeof error.details?.hint === 'string' ? {} : { hint: classification.hint }),
    ...(classification.retriable !== undefined && error.details?.retriable === undefined
      ? { retriable: classification.retriable }
      : {}),
  };
  return error;
}

// Timeout wins over text matchers: the exec layer deliberately builds timeout
// errors around "timed out after Nms" because partial output from the killed
// process is untrustworthy — classifying that partial stderr (e.g. flagging a
// half-written transport line retriable) would point away from the real fix.
function classifyAdbCommandError(error: AppError): AdbFailureClassification | undefined {
  if (typeof error.details?.timeoutMs === 'number') return ADB_TIMEOUT_CLASSIFICATION;
  const stderr = typeof error.details?.stderr === 'string' ? error.details.stderr : '';
  const stdout = typeof error.details?.stdout === 'string' ? error.details.stdout : '';
  return classifyAdbFailure(stderr, stdout);
}

/**
 * Builds the COMMAND_FAILED AppError for a failed `allowFailure` adb result and
 * runs it through the failure classifier. This is the shared construction point
 * for call sites that tolerate a failure to inspect it and then throw — those
 * errors never cross the executor throw path, so they classify here instead.
 * Site-provided `details` win on key collisions, and a site `hint` is preserved
 * over the classified one.
 *
 * Nonzero exits build their details via execFailureDetails, whose
 * processExitError flag makes normalizeError append the first stderr line to
 * the curated message — the classified hint and the stderr-excerpt enrichment
 * compose instead of competing. Semantic failures thrown at exit 0 (e.g. an
 * `am start` error printed on a successful exit) stay unflagged so a stray
 * stderr line never decorates a message the process exit does not back up.
 */
export function androidAdbResultError(
  message: string,
  result: Pick<AndroidAdbExecutorResult, 'exitCode' | 'stdout' | 'stderr'>,
  details?: Record<string, unknown>,
): AppError {
  const failureDetails =
    result.exitCode === 0
      ? { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, ...details }
      : execFailureDetails(result, details);
  return attachAdbFailureHint(new AppError('COMMAND_FAILED', message, failureDetails));
}

function withAdbFailureHints<Args extends unknown[], Result>(
  call: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (error) {
      throw attachAdbFailureHint(error);
    }
  };
}

// Providers already enriched by withAdbFailureHintProvider, so repeated
// normalization resolves to the same object instead of stacking wrappers.
const adbFailureHintProviders = new WeakSet<AndroidAdbProvider>();

/**
 * Wraps every promise-returning adb funnel a provider exposes — `exec` plus the
 * semantic `pull`/`install`/`installBundle` methods that bypass it — so a
 * provider failure (e.g. an INSTALL_FAILED verdict from `provider.install`)
 * carries the same classified hint as local execution. Applied once inside
 * {@link normalizeAndroidAdbProvider}, the single funnel every provider passes
 * through; the local provider needs no wrap because its methods delegate to the
 * already-enriched serial executor.
 */
function withAdbFailureHintProvider(provider: AndroidAdbProvider): AndroidAdbProvider {
  if (adbFailureHintProviders.has(provider)) return provider;
  const enriched: AndroidAdbProvider = {
    ...provider,
    exec: withAdbFailureHints(coerceAdbResults(provider.exec)),
    ...(provider.pull ? { pull: withAdbFailureHints(coerceAdbResults(provider.pull)) } : {}),
    ...(provider.install
      ? { install: withAdbFailureHints(coerceAdbResults(provider.install)) }
      : {}),
    ...(provider.installBundle
      ? { installBundle: withAdbFailureHints(provider.installBundle) }
      : {}),
  };
  adbFailureHintProviders.add(enriched);
  return enriched;
}

// Providers are SDK-supplied callbacks whose results cross an unchecked
// boundary; coerce them once here (see coerceExecResult) so downstream code
// can trust the ExecResult types. Wrapped inside the same enrichment pass so
// the WeakSet memo above also prevents coercer stacking.
function coerceAdbResults<Args extends unknown[]>(
  call: (...args: Args) => Promise<AndroidAdbExecutorResult>,
): (...args: Args) => Promise<AndroidAdbExecutorResult> {
  return async (...args) => coerceExecResult(await call(...args));
}

export function createDeviceAdbExecutor(device: DeviceInfo): AndroidAdbExecutor {
  return createSerialAdbExecutor(device.id);
}

function createSerialAdbExecutor(serial: string): AndroidAdbExecutor {
  return withAdbFailureHints(
    async (args, options) =>
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
      ),
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

export function resolveAndroidTouchProvider(device: DeviceInfo): AndroidTouchProvider | undefined {
  const scoped = androidAdbProviderScope.getStore();
  return scoped?.serial === device.id && scoped.provider.touch ? scoped.provider : undefined;
}

export function createAndroidPortReverseManager(
  provider: AndroidAdbProvider | AndroidAdbExecutor,
): AndroidPortReverseProvider {
  const normalized = normalizeAndroidAdbProvider(provider);
  if (normalized.reverse && managedAndroidPortReverseProviders.has(normalized.reverse)) {
    return normalized.reverse;
  }
  const reverse = normalized.reverse ?? createExecAndroidPortReverseProvider(normalized.exec);
  const active = new Map<AndroidPortReverseEndpoint, AndroidPortReverseMapping>();
  const manager: AndroidPortReverseProvider = {
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
  managedAndroidPortReverseProviders.add(manager);
  return manager;
}

function normalizeAndroidAdbProvider(
  provider: AndroidAdbProvider | AndroidAdbExecutor,
): AndroidAdbProvider {
  return withAdbFailureHintProvider(typeof provider === 'function' ? { exec: provider } : provider);
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
  // Normalization wraps once at scope installation, so every consumer — the
  // command-executor override and direct resolveAndroidAdb* lookups — gets
  // classified failure hints on exec and the semantic provider methods alike.
  const enriched = normalizeAndroidAdbProvider(provider);
  const scope = { provider: enriched, serial: options.serial };
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

const managedAndroidPortReverseProviders = new WeakSet<AndroidPortReverseProvider>();

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
        throw androidAdbResultError(`Failed to remove Android port reverse ${local}`, result, {
          local,
        });
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
