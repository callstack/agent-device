import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';
import type { AndroidInventoryConfig } from './inventory-config.ts';

const metadata = Object.freeze({
  family: 'android',
} satisfies PlatformModuleMetadata);

export type { AndroidInventoryConfig } from './inventory-config.ts';

export function createAndroidInventoryModule(
  config: AndroidInventoryConfig,
): InventoryPlatformModule<'android'> {
  const capturedConfig = Object.freeze({
    sdkRoots: Object.freeze([
      ...new Set(config.sdkRoots.map((root) => root.trim()).filter(Boolean)),
    ]),
  });
  return Object.freeze({
    ...metadata,
    loadInventory: async (host) => {
      const { createAndroidInventory } = await import('./inventory.ts');
      return createAndroidInventory(host, capturedConfig);
    },
  });
}
