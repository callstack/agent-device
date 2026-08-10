import type {
  AppLogRuntimePlatformModule,
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';

const metadata = Object.freeze({
  family: 'web',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (_host) => {
    const { createWebAppLogRuntime } = await import('./logs/runtime.ts');
    return createWebAppLogRuntime();
  },
} satisfies AppLogRuntimePlatformModule);

export const inventoryModule: InventoryPlatformModule<'web'> = Object.freeze({
  ...metadata,
  loadInventory: async () => {
    const { createWebInventory } = await import('./inventory.ts');
    return createWebInventory();
  },
});
