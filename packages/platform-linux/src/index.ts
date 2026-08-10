import type {
  InventoryPlatformModule,
  PlatformRuntimeModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';

const metadata = Object.freeze({
  family: 'linux',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (_host) => {
    const { createLinuxPlatformRuntime } = await import('./runtime.ts');
    return createLinuxPlatformRuntime();
  },
} satisfies PlatformRuntimeModule);

export const inventoryModule: InventoryPlatformModule<'linux'> = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createLinuxInventory } = await import('./inventory.ts');
    return createLinuxInventory(host);
  },
});
