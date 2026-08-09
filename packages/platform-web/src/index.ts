import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';

const metadata = Object.freeze({
  family: 'web',
} satisfies PlatformModuleMetadata);

export const inventoryModule: InventoryPlatformModule = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createWebInventory } = await import('./inventory.ts');
    return createWebInventory(host);
  },
});
