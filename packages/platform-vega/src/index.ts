import type {
  InventoryPlatformModule,
  PlatformRuntimeModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';

const metadata = Object.freeze({
  family: 'vega',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (_host) => {
    const { createVegaPlatformRuntime } = await import('./runtime.ts');
    return createVegaPlatformRuntime();
  },
} satisfies PlatformRuntimeModule);

export const inventoryModule: InventoryPlatformModule<'vega'> = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createVegaInventory } = await import('./inventory.ts');
    return createVegaInventory(host);
  },
});
