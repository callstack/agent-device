import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';

const metadata = Object.freeze({
  family: 'linux',
} satisfies PlatformModuleMetadata);

export const inventoryModule: InventoryPlatformModule = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createLinuxInventory } = await import('./inventory.ts');
    return createLinuxInventory(host);
  },
});
