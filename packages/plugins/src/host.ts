import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { AppError, type AppErrorCode, type AppErrorDetails } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';
import type { AppleApplicationToolsForProvider } from '@agent-device/contracts/application-lifecycle-runtime';

export type HostCommandResult = Readonly<{ stdout: string }>;

export type RunHostCommand = (
  command: string,
  args: readonly string[],
) => Promise<HostCommandResult>;

// The facet types below mirror the platform's adb shapes instead of importing them. The plugin
// contract is published in the installed package's declaration surface, where a platform-package
// declaration would exist twice as two unrelated copies and a branded or Node-primitive type would
// never match across them. Every mirror stays structurally identical to its platform original, so
// the composing root hands the same values to the platform's mechanics unchanged.
//
// Keeping the closure structural is what makes two plugin packages sharing one installed core still
// typecheck: each bundles this contract into its own declaration, and a consumer that hands such a
// plugin to `startAgentDevice` compares the bundled copy of `setup` against core's, member by member.
// An interactor cannot be named here for that reason. Its snapshot answer reaches
// `SnapshotViewportSize`, branded with a `unique symbol`, and no answer written by one copy of this
// contract answers to the other copy's brand. The composing root builds that operation and names it
// on its own facet type. The runtime value carries it for built-in composition; the published
// type does not declare it.
type ProviderAdbWaitTransport = '' | 'usb-' | 'local-' | 'any-';
type ProviderAdbWaitState = 'device' | 'recovery' | 'bootloader' | 'sideload' | 'sideload-window';

/** Transport readiness request adb accepts before a command, mirrored from the platform's typed grammar. */
export type ProviderAndroidAdbWait = `wait-for-${ProviderAdbWaitTransport}${ProviderAdbWaitState}`;

/** Which device an invocation addresses, mirrored from the platform. */
export type ProviderAndroidAdbSelector =
  | Readonly<{ kind: 'unspecified' }>
  | Readonly<{ kind: 'serial'; serial: string }>;

/** Which adb server an invocation addresses, mirrored from the platform. */
export type ProviderAndroidAdbServer =
  | Readonly<{ kind: 'ambient' }>
  | Readonly<{ kind: 'port'; port: number }>;

/** Transport addressing of one invocation, mirrored from the platform. */
export type ProviderAndroidAdbTarget = Readonly<{
  selector: ProviderAndroidAdbSelector;
  server: ProviderAndroidAdbServer;
  waitFor?: ProviderAndroidAdbWait;
  hostGlobals?: readonly string[];
}>;

/** Addressing plus the opaque device command, mirrored from the platform. */
export type ProviderAndroidAdbInvocation = Readonly<{
  target: ProviderAndroidAdbTarget;
  command: readonly string[];
  rawArgv?: readonly string[];
}>;

/**
 * Execution options, mirrored from the platform. `stdin` and the binary answer are named as
 * `Uint8Array`: the published contract has no Node buffer to name, and every platform buffer is a
 * `Uint8Array`, so the root hands the caller's options to the platform's mechanics unchanged and
 * converts only where a buffer of its own must be produced.
 */
export type ProviderAndroidExecutorOptions = Readonly<{
  allowFailure?: boolean;
  timeoutMs?: number;
  binaryStdout?: boolean;
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  serverPort?: number;
}>;

/**
 * One adb answer, mirrored from the platform. `stdout` is the decoded text, empty when the command
 * asked for binary stdout; `stdoutBuffer` carries the bytes `binaryStdout` captured.
 */
export type ProviderAndroidExecutorResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBuffer?: Uint8Array;
  signal?: string;
}>;

/** One device-scoped adb executor, mirrored from the platform. */
export type ProviderAndroidExecutor = (
  args: readonly string[],
  options?: ProviderAndroidExecutorOptions,
) => Promise<ProviderAndroidExecutorResult>;

/** One reverse-mapping endpoint, mirrored from the platform. */
export type ProviderAndroidPortReverseEndpoint = `tcp:${number}` | `localabstract:${string}`;

/** One reverse mapping, mirrored from the platform. */
export type ProviderAndroidPortReverseMapping = Readonly<{
  local: ProviderAndroidPortReverseEndpoint;
  remote: ProviderAndroidPortReverseEndpoint;
  ownerId?: string;
}>;

export type ProviderAndroidPortReverseOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

/** The reverse-mapping manager the facet builds; it owns the mappings it creates. */
export type ProviderAndroidPortReverse = Readonly<{
  ensure(
    mapping: ProviderAndroidPortReverseMapping,
    options?: ProviderAndroidPortReverseOptions,
  ): Promise<void>;
  remove(
    local: ProviderAndroidPortReverseEndpoint,
    options?: ProviderAndroidPortReverseOptions,
  ): Promise<void>;
  removeAllOwned(ownerId: string, options?: ProviderAndroidPortReverseOptions): Promise<void>;
  list?(options?: ProviderAndroidPortReverseOptions): Promise<ProviderAndroidPortReverseMapping[]>;
}>;

/** One text-entry request adb or the helper would have performed, mirrored from the platform's typed grammar. */
type ProviderAndroidTextInjectionRequest = Readonly<{
  /** Whether this is a plain entry or a replace-the-target's-text fill. */
  action: 'type' | 'fill';
  text: string;
  delayMs?: number;
  /** Present exactly for `fill`: the input the entry must land in, which the provider must focus first. */
  target?: Readonly<{ x: number; y: number }>;
}>;

/**
 * The provider-scoped executor the facet scopes, mirrored from the platform's provider minus its
 * optional extras. `text` is carried because the Android family reads it off the provider it installs
 * its scope over: a provider that can enter text natively keeps that route.
 */
export type ProviderAndroidAdbProvider = Readonly<{
  exec: ProviderAndroidExecutor;
  reverse?: ProviderAndroidPortReverse;
  text?: (request: ProviderAndroidTextInjectionRequest) => Promise<void>;
}>;

/**
 * The Android host capabilities a provider plugin runs adb through. Every method runs under the
 * host these capabilities were created for; ambient process values are not added. The composing
 * root builds them from the platform-owned mechanics, so a plugin package imports no platform code.
 */
export type ProviderAndroidHost = Readonly<{
  /**
   * Runs one already-addressed invocation over the host adb transport. A serial-target invocation
   * reaches one device; a host-target invocation selects none. Cancellation, binary stdout and the
   * typed failure contract are the platform's, passed through unchanged.
   */
  runAdb(
    invocation: ProviderAndroidAdbInvocation,
    options?: ProviderAndroidExecutorOptions,
  ): Promise<ProviderAndroidExecutorResult>;
  /** Builds the typed failure for a result the transport answered with, naming the invocation. */
  adbError(
    message: string,
    result: Pick<ProviderAndroidExecutorResult, 'exitCode' | 'stdout' | 'stderr'>,
    invocation?: ProviderAndroidAdbInvocation,
  ): Promise<AppError>;
  /** Scopes platform adb internals to this provider's executor for `serial` while `task` runs. */
  withAdbProvider<T>(
    provider: ProviderAndroidAdbProvider | ProviderAndroidExecutor,
    serial: string,
    task: () => Promise<T>,
  ): Promise<T>;
  /** Runs `adb shell <words>` through an executor; every word is quoted for the device shell. */
  runShell(
    adb: ProviderAndroidExecutor,
    words: readonly (string | number)[],
    options?: ProviderAndroidExecutorOptions,
  ): Promise<ProviderAndroidExecutorResult>;
  /** Builds the reverse-mapping manager for one executor; the manager owns its mappings. */
  createPortReverse(
    adb: ProviderAndroidExecutor,
    options: Readonly<{ noRebind?: boolean }>,
  ): Promise<ProviderAndroidPortReverse>;
  listApps(
    adb: ProviderAndroidExecutor,
    options?: Readonly<{ filter?: 'user-installed' | 'all'; target?: 'mobile' | 'tv' | 'auto' }>,
  ): Promise<Array<{ package: string; name: string }>>;
  readLogs(
    adb: ProviderAndroidExecutor,
    options?: Readonly<{ lines?: number; timeoutMs?: number; signal?: AbortSignal }>,
  ): Promise<string>;
  keyboardState(adb: ProviderAndroidExecutor): Promise<ProviderAndroidKeyboardState>;
  dismissKeyboard(adb: ProviderAndroidExecutor): Promise<ProviderAndroidKeyboardDismissResult>;
}>;

/** One keyboard reading, mirrored from the platform. */
export type ProviderAndroidKeyboardState = Readonly<{
  visible: boolean;
  inputType?: string;
  type?: 'text' | 'number' | 'email' | 'phone' | 'password' | 'datetime' | 'unknown';
  inputMethodPackage?: string;
  focusedPackage?: string;
  focusedResourceId?: string;
  inputOwner: 'app' | 'ime' | 'unknown';
}>;

/** One keyboard dismissal answer, mirrored from the platform. */
export type ProviderAndroidKeyboardDismissResult = ProviderAndroidKeyboardState &
  Readonly<{
    attempts: number;
    wasVisible: boolean;
    dismissed: boolean;
  }>;

/**
 * The Apple host capabilities a provider plugin drives a simulator through. `applicationTools` is
 * the root-composed Apple tool port: open-target resolution, runner-session mechanics, and runtime
 * hints, bound to the host these capabilities were created for. The daemon's own Apple shutdown
 * members are absent here and are removed from the value the root builds, so a plugin cannot stop
 * runner sessions its leases do not own.
 */
export type ProviderAppleHost = Readonly<{
  applicationTools: AppleApplicationToolsForProvider;
}>;

/** The platform facets a host may make available to a plugin's `setup`. Each is absent when this host does not serve that family. */
export type ProviderHostCapabilities = Readonly<{
  android?: ProviderAndroidHost;
  apple?: ProviderAppleHost;
}>;

export type ProviderPluginHost = Readonly<{
  /** Host-supplied command environment. Include PATH, HOME and provider inputs when needed. */
  env: Readonly<Record<string, string | undefined>>;
  options: Readonly<Record<string, unknown>>;
  clientVersion: string;
  createError(code: AppErrorCode, message: string, details?: AppErrorDetails): AppError;
  /** Runs in the supplied host cwd/env; ambient process values are not added. */
  runHostCommand: RunHostCommand;
  /** The Android host capabilities, or absent when the composing policy serves no Android host. */
  readonly android?: ProviderAndroidHost;
  /** The Apple host capabilities, or absent when the composing policy serves no Apple host. */
  readonly apple?: ProviderAppleHost;
}>;

export function createPluginHost(
  host: HostEnvironment,
  options: Record<string, unknown> | undefined,
  capabilities?: ProviderHostCapabilities,
): ProviderPluginHost {
  return Object.freeze({
    env: Object.freeze({ ...host.env }),
    options: Object.freeze({ ...options }),
    clientVersion: readVersion(),
    createError: (code, message, details) => new AppError(code, message, details),
    runHostCommand: async (command, args) => {
      const { runCmd } = await import('@agent-device/host-kit/command');
      const { stdout } = await runCmd(command, [...args], {
        cwd: host.cwd,
        env: host.env,
        maxBuffer: 10 * 1024 * 1024,
        timeoutMs: 30_000,
      });
      return { stdout };
    },
    ...(capabilities?.android ? { android: capabilities.android } : {}),
    ...(capabilities?.apple ? { apple: capabilities.apple } : {}),
  } satisfies ProviderPluginHost);
}
