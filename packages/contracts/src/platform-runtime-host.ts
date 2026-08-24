import type { DeviceInfo, Platform } from '@agent-device/kernel/device';
import type { JsonObject, JsonValue } from './json.ts';

export type HostCommandRequest = Readonly<{
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  allowFailure?: boolean;
}>;

export type HostCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
}>;

/** Exact host-process identity used by durable process-backed capabilities. */
export type ManagedProcessIdentity = Readonly<{
  pid: number;
  startTime: string;
  command: string;
}>;

export type ManagedProcessOwnership = 'missing' | 'owned-alive' | 'ownership-lost';

/**
 * A daemon-owned process identity that may outlive the request which spawned
 * it. The purpose is bounded recovery metadata, not a command selector.
 */
export type OwnedProcessRecord = ManagedProcessIdentity &
  Readonly<{
    purpose: string;
  }>;

export type OwnedProcessRecordScope =
  | Readonly<{ kind: 'daemon' }>
  | Readonly<{ kind: 'session'; sessionId: string }>;

/** Host-owned persistence seam for process records; platform code never owns the file format. */
export type OwnedProcessRecordWriter = Readonly<{
  replace(scope: OwnedProcessRecordScope, records: readonly OwnedProcessRecord[]): void;
  clear(scope: OwnedProcessRecordScope): void;
}>;

/** Generic process-execution port; focused Apple foreground tools use AppleToolHost. */
export type HostCommandRunner = Readonly<{
  which(executable: string): Promise<string | undefined>;
  run(request: HostCommandRequest, signal?: AbortSignal): Promise<HostCommandResult>;
}>;

export type AppleXcrunTool = 'simctl' | 'devicectl' | 'xctrace';

export type AppleToolRequest = Readonly<{
  tool: AppleXcrunTool;
  args: readonly string[];
  timeoutMs?: number;
  allowFailure?: boolean;
}>;

/** Request-bound foreground Apple tooling backed by the selected scoped provider. */
export type AppleToolHost = Readonly<{
  isXcrunAvailable(signal?: AbortSignal): Promise<boolean>;
  run(request: AppleToolRequest, signal?: AbortSignal): Promise<HostCommandResult>;
}>;

/** Device-scoped Android transport selected by root composition; packages own all adb arguments. */
export type AndroidToolHost = Readonly<{
  runAdb(
    device: DeviceInfo,
    args: readonly string[],
    options: Readonly<{ allowFailure?: boolean; timeoutMs?: number }>,
    signal?: AbortSignal,
  ): Promise<HostCommandResult>;
  installPackage(
    device: DeviceInfo,
    packagePath: string,
    options: Readonly<{ replace: boolean }>,
    signal?: AbortSignal,
  ): Promise<HostCommandResult>;
  /** Returns false when the selected transport has no bundle installer. */
  installBundle(
    device: DeviceInfo,
    bundlePath: string,
    mode: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
}>;

export type HostOperatingSystem = 'darwin' | 'linux' | 'win32' | 'other';

export type HostTemporaryTextFile = AsyncDisposable &
  Readonly<{
    path: string;
    readText(): Promise<string>;
    writeText(value: string): Promise<void>;
  }>;

export type DeviceInventoryFileHost = Readonly<{
  isExecutable(path: string): Promise<boolean>;
  createTemporaryTextFile(
    options: Readonly<{
      prefix: string;
      suffix: string;
    }>,
  ): Promise<HostTemporaryTextFile>;
}>;

export type DeviceObservationSink = Readonly<{
  /** Record only a fresh native-tool observation, never cached or persisted inventory. */
  deviceBooted(device: DeviceInfo): Promise<void>;
}>;

/**
 * Family-lazy bridge for process-lifetime toolchain preparation still shared
 * with legacy mechanics. Platform packages select a family but never receive
 * ambient environment or filesystem authority.
 */
export type HostToolchainPreparer = Readonly<{
  prepare(family: Platform): Promise<void>;
}>;

/**
 * Focused host mechanics needed by discovery implementations. Family-specific
 * configured paths remain package factory inputs, not a shared environment bag.
 */
export type DeviceInventoryHost = Readonly<{
  commands: HostCommandRunner;
  appleTools: AppleToolHost;
  toolchains: HostToolchainPreparer;
  files: DeviceInventoryFileHost;
  hostOs: HostOperatingSystem;
  hostName: string;
  homeDirectory: string;
  observations: DeviceObservationSink;
}>;

/** The exact host authority made visible to each family inventory implementation. */
export type DeviceInventoryHostByFamily = Readonly<{
  apple: Pick<DeviceInventoryHost, 'appleTools' | 'files' | 'hostName' | 'hostOs' | 'observations'>;
  android: Pick<DeviceInventoryHost, 'commands' | 'files' | 'homeDirectory' | 'toolchains'>;
  harmonyos: Pick<DeviceInventoryHost, 'commands' | 'files' | 'toolchains'>;
  vega: Pick<DeviceInventoryHost, 'commands' | 'files' | 'homeDirectory'>;
  linux: Pick<DeviceInventoryHost, 'hostName' | 'hostOs'>;
  web: never;
}>;

export type DeviceInventoryHostFor<Family extends Platform> = DeviceInventoryHostByFamily[Family];

export type PlatformDiagnosticEvent = Readonly<{
  level: 'debug' | 'info' | 'warn' | 'error';
  phase: string;
  message?: string;
  data?: JsonObject;
}>;

export type PlatformDiagnosticSink = Readonly<{
  emit(event: PlatformDiagnosticEvent): void;
}>;

export type PlatformProgressUpdate = Readonly<{
  phase: string;
  message: string;
  completed?: number;
  total?: number;
  data?: JsonValue;
}>;

export type PlatformProgressSink = Readonly<{
  report(update: PlatformProgressUpdate): void;
}>;

/** Request-lifetime attachments; durable handles must never retain this scope. */
export type PlatformRequestScope = Readonly<{
  signal: AbortSignal;
  diagnostics: PlatformDiagnosticSink;
  progress: PlatformProgressSink;
}>;

export type ResolvedNativeAsset = Readonly<{
  path: string;
  version?: string;
}>;

/** Asset names stay package-owned literal unions rather than a shared universal catalog. */
export type NativeAssetResolver<AssetName extends string> = Readonly<{
  resolve(name: AssetName, signal?: AbortSignal): Promise<ResolvedNativeAsset>;
}>;
