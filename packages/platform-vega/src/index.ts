import type {
  AppLogRuntimePlatformModule,
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';

const metadata = Object.freeze({
  family: 'vega',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (_host) => {
    const { createVegaAppLogRuntime } = await import('./logs/runtime.ts');
    return createVegaAppLogRuntime();
  },
} satisfies AppLogRuntimePlatformModule);

export const inventoryModule: InventoryPlatformModule<'vega'> = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createVegaInventory } = await import('./inventory.ts');
    return createVegaInventory(host);
  },
});
