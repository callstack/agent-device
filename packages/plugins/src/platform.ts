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
import type { OwnedProcessRecordStore } from '@agent-device/host-kit/process';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

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
