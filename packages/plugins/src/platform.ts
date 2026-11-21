import type { InventoryPlatformModule } from '@agent-device/contracts/platform-module';
import type { Platform } from '@agent-device/kernel/device';
import type {
  HarmonyPlatformOperations,
  HarmonyPlatformRegistration,
  PlatformPlugin,
  VegaPlatformOperations,
  VegaPlatformRegistration,
  WebPlatformOperations,
  WebPlatformRegistration,
} from '@agent-device/contracts/platform-plugin';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
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
            : unknown)
  : never;

export type RegisteredPlatformSetup<Family extends Platform = Platform> = Family extends Platform
  ? Family extends 'web'
    ? WebPlatformRegistration
    : Family extends 'vega'
      ? VegaPlatformRegistration
      : Family extends 'harmonyos'
        ? HarmonyPlatformRegistration
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
