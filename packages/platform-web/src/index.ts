import type {
  InventoryPlatformModule,
  PlatformRuntimeModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';

const metadata = Object.freeze({
  family: 'web',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createWebPlatformRuntime } = await import('./runtime.ts');
    return createWebPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

export const inventoryModule: InventoryPlatformModule<'web'> = Object.freeze({
  ...metadata,
  loadInventory: async () => {
    const { createWebInventory } = await import('./inventory.ts');
    return createWebInventory();
  },
});
