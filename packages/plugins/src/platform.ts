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
