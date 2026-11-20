import type {
  InventoryPlatformModule,
  OptionalPlatform,
} from '@agent-device/contracts/platform-module';
import type {
  PlatformPlugin,
  WebPlatformOperations,
  WebPlatformRegistration,
} from '@agent-device/contracts/platform-plugin';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
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

export type PlatformSetup<Family extends OptionalPlatform = OptionalPlatform> =
  Family extends OptionalPlatform
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
          : unknown)
    : never;

/** Full module types used after the composing registry validates the declared family and loaders. */
export type RegisteredPlatformSetup<Family extends OptionalPlatform = OptionalPlatform> =
  Family extends OptionalPlatform
    ? Family extends 'web'
      ? WebPlatformRegistration
      : Omit<PlatformSetup<Family>, 'inventoryModule' | 'runtimeModule' | 'createInteractor'> &
          Readonly<{
            createInteractor: PlatformPlugin['createInteractor'];
            inventoryModule: InventoryPlatformModule<Family>;
            runtimeModule: PlatformRuntimeModule & { readonly family: Family };
          }>
    : never;

export type PlatformContribution = {
  [Family in OptionalPlatform]: Readonly<{
    kind: 'platform';
    family: Family;
    /** Registers modules and operations. Setup itself does not start or install the backend. */
    setup(host: PlatformHost): PlatformSetup<Family> | Promise<PlatformSetup<Family>>;
  }>;
}[OptionalPlatform];
