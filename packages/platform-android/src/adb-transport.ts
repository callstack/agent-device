import type { Readable, Stream, Writable } from 'node:stream';
import type { Rect } from '@agent-device/kernel/snapshot';
import type {
  AndroidImeHelperArtifact,
  AndroidSnapshotHelperArtifact,
} from '@agent-device/contracts/android-helper-artifacts';
import type { AndroidProviderTouchPlan } from '@agent-device/contracts/android-touch-plan';

// The adb transport vocabulary: the executor/provider shapes every module of the cluster (and
// the SDK, through the root shim) speaks, plus the one pure lowering from semantic install
// options to adb flags. No behavior lives here beyond that lowering.

export type AndroidAdbExecutorOptions = {
  allowFailure?: boolean;
  timeoutMs?: number;
  binaryStdout?: boolean;
  stdin?: string | Buffer;
  signal?: AbortSignal;
};

export type AndroidAdbExecutorResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBuffer?: Buffer;
};

/** Structural mirror of node's StdioOptions; R13 bars the child_process import that names it. */
type AndroidAdbStdioOption = 'overlapped' | 'pipe' | 'ignore' | 'inherit';

export type AndroidAdbSpawnOptions = AndroidAdbExecutorOptions & {
  cwd?: string;
  env?: Record<string, string | undefined>;
  detached?: boolean;
  /** Max stdout/stderr bytes for synchronous runs (default Node ~1MB). */
  maxBuffer?: number;
  stdio?:
    | AndroidAdbStdioOption
    | Array<AndroidAdbStdioOption | 'ipc' | Stream | number | null | undefined>;
  /**
   * Capture stdout/stderr into the wait result when the child has piped stdio.
   * Set false when the caller owns, ignores, or forwards the streams.
   */
  captureOutput?: boolean;
};

export type AndroidAdbProcess = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
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
  options?: AndroidAdbSpawnOptions,
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
  options: Readonly<{ mode: string; signal?: AbortSignal }>,
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
  imeHelperArtifact?: AndroidImeHelperArtifact;
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

export type ScopedAndroidAdbBackgroundTransport =
  | Readonly<{ mode: 'local' }>
  | Readonly<{ mode: 'transport-composed'; spawn?: AndroidAdbSpawner }>;

export function normalizeAndroidAdbInstallOptions(options?: AndroidAdbInstallOptions): {
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
