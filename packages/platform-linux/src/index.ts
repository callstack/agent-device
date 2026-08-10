import type {
  AppLogRuntimePlatformModule,
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';

const metadata = Object.freeze({
  family: 'linux',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (_host) => {
    const { createLinuxAppLogRuntime } = await import('./logs/runtime.ts');
    return createLinuxAppLogRuntime();
  },
} satisfies AppLogRuntimePlatformModule);

export const inventoryModule: InventoryPlatformModule<'linux'> = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createLinuxInventory } = await import('./inventory.ts');
    return createLinuxInventory(host);
  },
});
