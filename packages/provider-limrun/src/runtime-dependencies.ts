import type { AppsFilter } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interaction';
import type { AndroidInputOwner } from '@agent-device/contracts/platform';
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
  args: string[],
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
  adbError(
    message: string,
    result: LimrunAdbCommandResult,
    details?: Record<string, unknown>,
  ): Promise<AppError>;
};

export type LimrunHostAdapter = {
  runAdb(args: string[], options?: LimrunAdbCommandOptions): Promise<LimrunAdbCommandResult>;
  archiveDirectory(options: {
    sourceDirectory: string;
    entryName: string;
    archivePath: string;
  }): Promise<void>;
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
