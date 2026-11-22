import type { DeviceInfo, Platform } from '@agent-device/kernel/device';
import type { JsonObject, JsonValue } from './json.ts';
import type { AndroidClipboardShellSupport } from './android-clipboard-support.ts';

// The composition root names the runtime host through this contract rather than the kernel
// substrate directly (R13): one host object is the whole configuration surface a runtime reads.
export type { HostEnvironment } from '@agent-device/kernel/source-value';

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
 * Whether a durable process record still names the live process it recorded, as the process that owns
 * process reads answers. {@link ManagedProcessOwnership} asks a caller's own marker for a process it
 * started; this asks a record an earlier run wrote. A process the host's table did not list stays
 * `unobserved` rather than becoming proof it exited, so a caller never acts on a process-tool read
 * that simply failed.
 */
export type RecordedProcessLiveness = 'alive' | 'not-alive' | 'unobserved';

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

/**
 * How a process the host started detached ended: a start failure, a non-zero exit, or a signal.
 * Declared once here rather than by its shape in each contract that reports one, because a host that
 * starts a detached process, a family that launches through that host, and the host's own exec module
 * all answer the same question. It names `signal` as a `string` rather than as Node's `Signals`, so a
 * consumer that writes a plugin reads this declaration without Node's own type packages.
 */
export type DetachedCommandExit = Readonly<{
  pid: number;
  exitCode?: number;
  signal?: string;
  error?: string;
}>;

/** What the host answered a detached launch: the process it started and how that process ended. */
export type DetachedCommandLaunch = Readonly<{
  pid: number;
  exited: Promise<DetachedCommandExit>;
}>;

export type AppleXcrunTool = 'simctl' | 'devicectl' | 'xctrace';

declare const scopedSimctlArgs: unique symbol;
/** simctl argv (after the tool name) already scoped to its simulator set; minted only by platform-apple. */
export type ScopedSimctlArgs = readonly string[] & { readonly [scopedSimctlArgs]: true };

declare const scopedSimctlCommand: unique symbol;
/** The xcrun argv of one simctl call: `simctl` followed by arguments already scoped to their set. */
export type ScopedSimctlCommand = readonly ['simctl', ...string[]] & {
  readonly [scopedSimctlCommand]: true;
};

export type AppleToolRequest = Readonly<{ timeoutMs?: number; allowFailure?: boolean }> &
  (
    | Readonly<{ tool: 'simctl'; args: ScopedSimctlArgs }>
    | Readonly<{ tool: Exclude<AppleXcrunTool, 'simctl'>; args: readonly string[] }>
  );

/** Request-bound foreground Apple tooling backed by the selected scoped provider. */
export type AppleToolHost = Readonly<{
  isXcrunAvailable(signal?: AbortSignal): Promise<boolean>;
  run(request: AppleToolRequest, signal?: AbortSignal): Promise<HostCommandResult>;
}>;

/** Device-scoped Android transport selected by root composition; packages own all adb arguments. */
export type AndroidToolHost = Readonly<{
  /**
   * Asks this device whether its clipboard service answers shell commands, as typed evidence.
   *
   * A host method rather than a `runAdb` call the caller classifies itself: normalizing adb's
   * output is Android tool knowledge, and it happens once here rather than in every owner that
   * needs the verdict.
   *
   * Optional, and its absence is not permission to assume support: a host that cannot probe
   * leaves the owner unable to establish the capability, so the clipboard is refused rather than
   * admitted. Only fabricated availability is forbidden — a refusal on incomplete information is
   * the safe answer.
   */
  probeClipboardShellSupport?(
    device: DeviceInfo,
    signal?: AbortSignal,
  ): Promise<AndroidClipboardShellSupport>;
  runAdb(
    device: DeviceInfo,
    args: readonly string[],
    options: Readonly<{ allowFailure?: boolean; timeoutMs?: number }>,
    signal?: AbortSignal,
  ): Promise<HostCommandResult>;
  installPackage(
    device: DeviceInfo,
    packagePath: string,
    options: Readonly<{ replace: boolean; timeoutMs?: number }>,
    signal?: AbortSignal,
  ): Promise<HostCommandResult>;
  /** Returns false when the selected transport has no bundle installer. */
  installBundle(
    device: DeviceInfo,
    bundlePath: string,
    mode: string,
    options?: Readonly<{ timeoutMs?: number }>,
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
  /**
   * The home this host names, or undefined when it names none (HOME and USERPROFILE both
   * absent). A host with no home still inventories: only default paths derived from the home
   * turn off, never the whole host.
   */
  homeDirectory: string | undefined;
  observations: DeviceObservationSink;
}>;

/** The exact host authority made visible to each family inventory implementation. */
export type DeviceInventoryHostByFamily = Readonly<{
  apple: Pick<DeviceInventoryHost, 'appleTools' | 'files' | 'hostName' | 'hostOs' | 'observations'>;
  android: Pick<DeviceInventoryHost, 'commands' | 'files' | 'homeDirectory' | 'toolchains'>;
  /** The HarmonyOS plugin carries its own host, so its inventory asks the core for nothing. */
  harmonyos: never;
  /** The Vega plugin carries its own host, so its inventory asks the core for nothing. */
  vega: never;
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
  /** Enforces active execution/recovery cutoffs through their live owners, without another timer. */
  checkDeadline?(): void;
  diagnostics: PlatformDiagnosticSink;
  progress: PlatformProgressSink;
}>;
