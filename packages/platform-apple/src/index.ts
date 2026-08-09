import type {
  AppLogRuntimePlatformModule,
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';

const metadata = Object.freeze({
  family: 'apple',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createAppleAppLogRuntime } = await import('./logs/runtime.ts');
    return createAppleAppLogRuntime(host);
  },
} satisfies AppLogRuntimePlatformModule);

export const inventoryModule = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createAppleInventorySource } = await import('./inventory.ts');
    return createAppleInventorySource(host);
  },
} satisfies InventoryPlatformModule<'apple'>);
