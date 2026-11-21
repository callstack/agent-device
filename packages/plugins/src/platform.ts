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
import type { OwnedProcessRecordStore } from '@agent-device/host-kit/process';
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
