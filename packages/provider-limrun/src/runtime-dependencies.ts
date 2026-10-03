import type { AndroidAdbInvocation } from '@agent-device/platform-android/mechanics';
import type { AppsFilter } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { AndroidInputOwner } from '@agent-device/contracts/android-input-ownership';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppError } from '@agent-device/kernel/errors';

export type LimrunAdbCommandOptions = {
  allowFailure?: boolean;
  binaryStdout?: boolean;
  stdin?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type LimrunAdbCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBuffer?: Buffer;
};

export type LimrunAdbExecutor = (
  args: readonly string[],
  options?: LimrunAdbCommandOptions,
) => Promise<LimrunAdbCommandResult>;

export type LimrunPortReverseEndpoint = `tcp:${number}` | `localabstract:${string}`;

export type LimrunPortReverseMapping = {
  local: LimrunPortReverseEndpoint;
  remote: LimrunPortReverseEndpoint;
  ownerId?: string;
};

export type LimrunPortReverseOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type LimrunPortReverse = {
  ensure(mapping: LimrunPortReverseMapping, options?: LimrunPortReverseOptions): Promise<void>;
  remove(local: LimrunPortReverseEndpoint, options?: LimrunPortReverseOptions): Promise<void>;
  removeAllOwned(ownerId: string, options?: LimrunPortReverseOptions): Promise<void>;
  list?(options?: LimrunPortReverseOptions): Promise<LimrunPortReverseMapping[]>;
};

export type LimrunAdbProvider = {
  exec: LimrunAdbExecutor;
  reverse?: LimrunPortReverse;
  text?: (request: {
    action: 'type' | 'fill';
    text: string;
    delayMs?: number;
    target?: { x: number; y: number };
  }) => Promise<void>;
};

export type LimrunAndroidKeyboardState = {
  visible: boolean;
  inputType?: string;
  type?: 'text' | 'number' | 'email' | 'phone' | 'password' | 'datetime' | 'unknown';
  inputMethodPackage?: string;
  focusedPackage?: string;
  focusedResourceId?: string;
  inputOwner: AndroidInputOwner;
};

export type LimrunAndroidKeyboardDismissResult = LimrunAndroidKeyboardState & {
  attempts: number;
  wasVisible: boolean;
  dismissed: boolean;
};

export type LimrunAndroidRuntimeAdapter = {
  // Interactors need provider-scoped capabilities; command helpers below need only ADB execution.
  createInteractor(device: DeviceInfo, adb: LimrunAdbProvider): Interactor;
  createPortReverse(adb: LimrunAdbExecutor): Promise<LimrunPortReverse>;
  inferAppName(packageName: string): Promise<string>;
  listApps(
    adb: LimrunAdbExecutor,
    filter: AppsFilter,
  ): Promise<Array<{ id: string; name?: string }>>;
  getForegroundApp(
    device: DeviceInfo,
    adb: LimrunAdbExecutor,
    signal?: AbortSignal,
  ): Promise<{ appId?: string; activity?: string } | undefined>;
  getKeyboardState(adb: LimrunAdbExecutor): Promise<LimrunAndroidKeyboardState>;
  dismissKeyboard(adb: LimrunAdbExecutor): Promise<LimrunAndroidKeyboardDismissResult>;
  readLogs(adb: LimrunAdbExecutor, lineLimit: number): Promise<string>;
  /** Stops the app so an install cannot inherit a running process. Tolerates a device that says no. */
  forceStopApp(adb: LimrunAdbExecutor, packageName: string, signal?: AbortSignal): Promise<void>;
  /**
   * Addresses one device command at `serial`, the tunnel this provider opened. The serial is the
   * provider's own addressing decision and belongs to the target, so the command array the Android
   * cluster handed over reaches the host unchanged. The builders come from the composition root
   * rather than an import: ADR-0019 keeps a provider's eager closure off the platform
   * implementation, and an invocation is built by the platform's typed grammar.
   */
  deviceAdbInvocation(serial: string, command: readonly string[]): AndroidAdbInvocation;
  /** Addresses one server-level command, which selects no device. */
  hostAdbInvocation(command: readonly string[]): AndroidAdbInvocation;
  /**
   * Builds the failure an ADB command answered with. The invocation is what was asked of adb; how
   * it is named in the error belongs to whoever renders it, not to this provider.
   */
  adbError(
    message: string,
    result: LimrunAdbCommandResult,
    invocation?: AndroidAdbInvocation,
  ): Promise<AppError>;
};

/** One authenticated HTTP download the host performs on the provider's behalf, bounded by `timeoutMs`. */
export type LimrunFileDownload = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  destinationPath: string;
  timeoutMs: number;
}>;

export type LimrunHostAdapter = {
  runAdb(
    invocation: AndroidAdbInvocation,
    options?: LimrunAdbCommandOptions,
  ): Promise<LimrunAdbCommandResult>;
  archiveDirectory(options: {
    sourceDirectory: string;
    entryName: string;
    archivePath: string;
  }): Promise<void>;
  downloadFile(options: LimrunFileDownload): Promise<void>;
};

export type LimrunIosRuntimeAdapter = {
  resolveAppAlias(app: string): Promise<string>;
  readBundleAppName(appPath: string): Promise<string | undefined>;
};

export type LimrunRuntimeDependencies = {
  clientVersion: string;
  android: LimrunAndroidRuntimeAdapter;
  host: LimrunHostAdapter;
  ios: LimrunIosRuntimeAdapter;
};
