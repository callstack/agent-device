import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';

const metadata = Object.freeze({
  family: 'vega',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createVegaPlatformRuntime } = await import('./runtime.ts');
    return createVegaPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

export const inventoryModule: InventoryPlatformModule<'vega'> = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createVegaInventory } = await import('./inventory.ts');
    return createVegaInventory(host);
  },
});
