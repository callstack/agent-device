import type {
  AppStateRuntimeHost,
  AppStateRuntimeResult,
} from '@agent-device/contracts/app-state-runtime';
import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidInventoryConfig } from './inventory-config.ts';
import type { AndroidAppStateHost } from './app-state.ts';
import type {
  AndroidObservationAdapter,
  AndroidObservationHost,
} from '@agent-device/contracts/android-observation';

const metadata = Object.freeze({
  family: 'android',
} satisfies PlatformModuleMetadata);

export type { AndroidInventoryConfig } from './inventory-config.ts';
export type { AndroidAppStateHost } from './app-state.ts';

/** Package-owned Android observation policy, loaded only when a daemon request needs it. */
export function createAndroidObservationAdapter(
  host: AndroidObservationHost,
): AndroidObservationAdapter {
  let implementation: Promise<AndroidObservationAdapter> | undefined;
  const load = () => {
    implementation ??= import('./observation.ts').then(({ createAndroidObservationAdapter }) =>
      createAndroidObservationAdapter(host),
    );
    return implementation;
  };
  return Object.freeze({
    readAppState: async (...args) => await (await load()).readAppState(...args),
    readBlockingDialog: async (...args) => await (await load()).readBlockingDialog(...args),
    readAppFocus: async (...args) => await (await load()).readAppFocus(...args),
    readSnapshotNodes: async (...args) => await (await load()).readSnapshotNodes(...args),
    tap: async (...args) => await (await load()).tap(...args),
    openApp: async (...args) => await (await load()).openApp(...args),
    readScreenSize: async (...args) => await (await load()).readScreenSize(...args),
    isPermissionPackage: async (...args) => await (await load()).isPermissionPackage(...args),
  });
}

export async function readAndroidAppState(
  host: AndroidAppStateHost | AppStateRuntimeHost['android'],
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<AppStateRuntimeResult> {
  const { readAndroidAppState: read } = await import('./app-state.ts');
  return await read(host, device, signal);
}

export async function readAndroidAppStateWithExecutor(
  run: import('./app-state.ts').AndroidCommandExecutor,
): Promise<import('@agent-device/contracts/app-state-runtime').AppStateRuntimeResult> {
  const { readAndroidAppStateWithExecutor: read } = await import('./app-state.ts');
  return await read(run);
}

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createAndroidPlatformRuntime } = await import('./runtime.ts');
    return createAndroidPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

export function createAndroidInventoryModule(
  config: AndroidInventoryConfig,
): InventoryPlatformModule<'android'> {
  const capturedConfig = Object.freeze({
    sdkRoots: Object.freeze([
      ...new Set(config.sdkRoots.map((root) => root.trim()).filter(Boolean)),
    ]),
  });
  return Object.freeze({
    ...metadata,
    loadInventory: async (host) => {
      const { createAndroidInventory } = await import('./inventory.ts');
      return createAndroidInventory(host, capturedConfig);
    },
  });
}

/** Loads Android shutdown mechanics only when the neutral shutdown capability is exercised. */
export async function loadShutdownRuntime(
  dependencies: Pick<DeviceShutdownRuntimeDependencies, 'commands'>,
) {
  const { createAndroidShutdownRuntime } = await import('./shutdown/runtime.ts');
  return createAndroidShutdownRuntime(dependencies);
}
