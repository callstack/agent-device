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
import type {
  HostProcessIdentityFacts,
  HostProcessIdentityObservation,
  HostProcessInfo,
  OwnedProcessReapSummary,
  OwnedProcessRecordStore,
} from '@agent-device/host-kit/process';
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
     * What the host answers about processes the plugin already has pids for.
     *
     * A plugin is bundled with its own copy of the host kit, and the request's command-host and
     * diagnostic scopes never enter that copy, so a process tool run from there answers with the
     * daemon process environment and traces into the plugin's own store instead of the request's.
     * Every process read a plugin makes therefore goes through this facet. Each read keeps its
     * fail-closed answer: a pid the host did not answer for is unknown evidence, never proof a
     * process is gone.
     */
    processes: PlatformHostProcesses;
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

/**
 * The process facet of {@link PlatformHost}: reads a plugin may make about pids it already knows,
 * and the stop that acts on one. Named apart from the host so a plugin can pass just what a fleet
 * scan needs.
 */
export type PlatformHostProcesses = Readonly<{
  /** The host's process table. A plugin accounts for a fleet it started from this one read. */
  list(options: { timeoutMs: number }): Promise<readonly HostProcessInfo[]>;
  /**
   * What the host says about each pid named, as the facts a caller acts on before it signals:
   * start time, command, and whether the pid is a zombie. A pid the host did not answer for maps to
   * all-`null` facts.
   */
  readIdentities(
    pids: Iterable<number>,
    options?: { timeoutMs?: number },
  ): Promise<ReadonlyMap<number, HostProcessIdentityFacts>>;
  /**
   * State and start time per pid from one process-tool snapshot. Unlike {@link readIdentities}, a
   * pid the snapshot did not list is absent from the answer rather than answered with nothing.
   */
  readIdentityObservations(
    pids: Iterable<number>,
  ): Promise<ReadonlyMap<number, HostProcessIdentityObservation>>;
  /**
   * The executable each pid is running, for a caller that must prove provenance rather than match a
   * command line. A pid the host cannot name is absent, which is unknown evidence, not absence of
   * the process.
   */
  readExecutablePaths(pids: Iterable<number>): Promise<ReadonlyMap<number, string>>;
  /**
   * Stops every process an owned-process record names, and forgets only the ones it watched leave.
   * The store is the host's own, so the record the reaper rewrites is the one the daemon reads. The
   * reaper's own identity reads and signals run under the host, exactly as a stop does.
   */
  reapOwnedRecords(
    store: OwnedProcessRecordStore,
    options?: {
      openWebSessionNames?: readonly string[];
      purposes?: readonly string[];
      termTimeoutMs?: number;
      killTimeoutMs?: number;
    },
  ): Promise<OwnedProcessReapSummary>;
  /**
   * Runs `task` while the host holds the process lock at `lockDirPath`, and answers the lock's own
   * questions — which process owns the claim, and whether that owner is still that process — from the
   * host's copy of the lock mechanics.
   *
   * A lock is not a file write: claiming one names this process's identity with a process-tool read,
   * and every poll of a held or stale lock re-proves the recorded owner and the guard holder with
   * another. Run from the plugin's bundled copy, those reads answer with the daemon process
   * environment and trace into the bundle's own store, so the request that waited shows no wait. The
   * host is the process that takes the claim, so it names its own identity rather than being told it.
   */
  withLock<T>(params: {
    /** The lock directory the host creates, holds and removes. */
    lockDirPath: string;
    /** How long the plugin will wait for a claim it cannot take; the host owns the poll. */
    timeoutMs: number;
    /** Names this lock in a timeout or an unverified release, in the request's log. */
    description?: string;
    task: () => Promise<T>;
  }): Promise<T>;
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
