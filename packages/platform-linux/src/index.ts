import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';

const metadata = Object.freeze({
  family: 'linux',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createLinuxPlatformRuntime } = await import('./runtime.ts');
    return createLinuxPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

export const inventoryModule: InventoryPlatformModule<'linux'> = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createLinuxInventory } = await import('./inventory.ts');
    return createLinuxInventory(host);
  },
});
