import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';

const metadata = Object.freeze({
  family: 'apple',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createApplePlatformRuntime } = await import('./runtime.ts');
    return createApplePlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

export const inventoryModule = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createAppleInventorySource } = await import('./inventory.ts');
    return createAppleInventorySource(host);
  },
} satisfies InventoryPlatformModule<'apple'>);

/** Loads Apple shutdown mechanics only when the neutral shutdown capability is exercised. */
export async function loadShutdownRuntime(
  dependencies: Pick<DeviceShutdownRuntimeDependencies, 'appleTools'>,
) {
  const { createAppleShutdownRuntime } = await import('./shutdown/runtime.ts');
  return createAppleShutdownRuntime(dependencies);
}
