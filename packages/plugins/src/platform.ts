import type { InventoryPlatformModule } from '@agent-device/contracts/platform-module';
import type { Platform } from '@agent-device/kernel/device';
import type {
  HarmonyPlatformOperations,
  HarmonyPlatformRegistration,
  LinuxPlatformOperations,
  LinuxPlatformRegistration,
  PlatformPlugin,
  VegaPlatformOperations,
  VegaPlatformRegistration,
  WebPlatformOperations,
  WebPlatformRegistration,
} from '@agent-device/contracts/platform-plugin';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type { LinuxToolProvider } from '@agent-device/contracts/linux-tool-provider';
import type { VegaToolProvider } from '@agent-device/contracts/vega-tool-provider';
import type { WebProvider } from '@agent-device/contracts/web-provider';
import type { DiagnosticEventInput, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import type { HostProcessInfo, OwnedProcessRecordStore } from '@agent-device/host-kit/process';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

/**
 * One command the host keeps running after the call returns: a device log tail a plugin streams
 * rather than a command it waits an answer from. `env` is the environment the caller prepared, so a
 * family that resolves its toolchain from roots the core does not name spawns with the same `PATH`
 * its one-shot commands use. The host owns the process table entry, the stop, and the marker.
 */
export type PlatformBackgroundCommand = Readonly<{
  executable: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  allowFailure?: boolean;
}>;

/** Where the host appends a background command's output. */
export type PlatformOutputSink = AsyncDisposable &
  Readonly<{
    write(chunk: string | Uint8Array): Promise<void>;
  }>;

/**
 * A background command the host started. `marker` is the published proof of ownership when the
 * request named a `markerPath`; `terminate` stops the process the host started and settles `wait`.
 */
export type PlatformBackgroundProcess = AsyncDisposable &
  Readonly<{
    marker?: Readonly<{ pid: number; startTime: string; command: string }>;
    wait: Promise<{ stdout: string; stderr: string; exitCode: number | null; signal?: string }>;
    terminate(): Promise<void>;
  }>;

/**
 * How a process the host started detached ended: a start failure, a non-zero exit, or a signal.
 * Declared by its shape rather than taken from the host's exec module, because this contract ships in
 * the published bundle's declarations and a consumer that writes a plugin must not need Node's own
 * type packages to read it.
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

/** Authority shared by web setup and daemon-owned web sessions. */
export type PlatformHost = HostEnvironment &
  Readonly<{
    stateDir: string;
    openWebSessionNames?(): readonly string[];
    ownedProcessRecords?: OwnedProcessRecordStore;
    runCommand(
      executable: string,
      args: string[],
      options: {
        env?: HostEnvironment['env'];
        allowFailure?: boolean;
        timeoutMs?: number;
        signal?: AbortSignal;
        stdin?: string;
      },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    /**
     * True when `path` is a file the host can execute. A plugin that resolves a tool from a
     * directory it was configured with asks the host rather than reading the filesystem itself, so
     * the probe uses the same host authority as the spawn it authorizes.
     */
    isFileExecutable(path: string): Promise<boolean>;
    /**
     * Whether the host resolves `executable` on its `PATH`, answered against the host environment
     * the plugin was set up with. A plugin that prefers a tool from `PATH` asks this rather than
     * searching `PATH` itself, so the lookup and the spawn it authorizes read one environment.
     */
    isExecutableOnPath(executable: string): Promise<boolean>;
    /**
     * The host's process table. A plugin that accounts for a fleet it started asks the host instead
     * of running a process tool itself, so the read uses the host's own executable resolution and
     * stays apart from whatever command override one request of this daemon carries.
     */
    listHostProcesses(options: { timeoutMs: number }): Promise<readonly HostProcessInfo[]>;
    /**
     * Starts one streamed command as a managed process: the host publishes an ownership marker at
     * `markerPath` while the process lives, clears it when the process ends, and stops the process on
     * `terminate()`. A plugin streams through this rather than spawning a process of its own, so a
     * streamed log is the same kind of durable resource the core recovers and cleans up. Absent when
     * the process composing this host owns no session artifacts to confine a marker to.
     */
    startBackgroundCommand?(
      request: Readonly<{
        command: PlatformBackgroundCommand;
        output: PlatformOutputSink;
        markerPath?: string;
      }>,
      signal?: AbortSignal,
    ): Promise<PlatformBackgroundProcess>;
    /**
     * Starts `executable` detached, with its output discarded, and answers how it ended. A target
     * that outlives the call that started it — a desktop app, a display-server helper — must not
     * hold the request open for its whole life, so the host starts it, unrefs it, and reports its
     * exit through `exited` instead of awaiting it. Absent where the host cannot start a process
     * that outlives the request; a family that needs it says so rather than waiting on a spawn it
     * never got.
     */
    launchDetached?(
      executable: string,
      args: string[],
      options: { env?: HostEnvironment['env'] },
    ): Promise<DetachedCommandLaunch>;
    emitDiagnostic(event: DiagnosticEventInput): void;
    withDiagnosticTimer: typeof withDiagnosticTimer;
  }>;

export type PlatformSetup<Family extends Platform = Platform> = Family extends Platform
  ? Readonly<{
      family: Family;
      inventoryModule: Readonly<{
        family: Family;
        loadInventory(...args: never[]): Promise<unknown>;
      }>;
      runtimeModule: Readonly<{
        family: Family;
        loadRuntime(...args: never[]): Promise<unknown>;
      }>;
      createInteractor(...args: never[]): Promise<unknown>;
    }> &
      (Family extends 'web'
        ? Readonly<{
            withRequestProvider<T>(provider: WebProvider, task: () => Promise<T>): Promise<T>;
            operations: WebPlatformOperations;
          }>
        : Family extends 'vega'
          ? Readonly<{
              withRequestProvider<T>(
                provider: VegaToolProvider,
                task: () => Promise<T>,
              ): Promise<T>;
              operations: VegaPlatformOperations;
            }>
          : Family extends 'harmonyos'
            ? Readonly<{ operations: HarmonyPlatformOperations }>
            : Family extends 'linux'
              ? Readonly<{
                  withRequestProvider<T>(
                    provider: LinuxToolProvider,
                    task: () => Promise<T>,
                  ): Promise<T>;
                  operations: LinuxPlatformOperations;
                }>
              : unknown)
  : never;

export type RegisteredPlatformSetup<Family extends Platform = Platform> = Family extends Platform
  ? Family extends 'web'
    ? WebPlatformRegistration
    : Family extends 'vega'
      ? VegaPlatformRegistration
      : Family extends 'harmonyos'
        ? HarmonyPlatformRegistration
        : Family extends 'linux'
          ? LinuxPlatformRegistration
          : Readonly<{
              family: Family;
              createInteractor: PlatformPlugin['createInteractor'];
              inventoryModule: InventoryPlatformModule<Family>;
              runtimeModule: PlatformRuntimeModule & { readonly family: Family };
            }>
  : never;

export type PlatformContribution = {
  [Family in Platform]: Readonly<{
    kind: 'platform';
    family: Family;
    /** Registers modules and operations. Setup itself does not start or install the backend. */
    setup(host: PlatformHost): PlatformSetup<Family> | Promise<PlatformSetup<Family>>;
  }>;
}[Platform];
