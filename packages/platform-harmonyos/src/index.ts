import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';
import type { HarmonyInventoryConfig } from './inventory-config.ts';

const metadata = Object.freeze({
  family: 'harmonyos',
} satisfies PlatformModuleMetadata);

export type { HarmonyInventoryConfig } from './inventory-config.ts';

export function createHarmonyInventoryModule(
  config: HarmonyInventoryConfig,
): InventoryPlatformModule<'harmonyos'> {
  const capturedConfig = Object.freeze({
    hdcSdkPath: normalizedRoot(config.hdcSdkPath),
    devecoSdkHome: normalizedRoot(config.devecoSdkHome),
    commandLineToolsHome: normalizedRoot(config.commandLineToolsHome),
  });
  return Object.freeze({
    ...metadata,
    loadInventory: async (host) => {
      const { createHarmonyInventory } = await import('./inventory.ts');
      return createHarmonyInventory(host, capturedConfig);
    },
  });
}

function normalizedRoot(root: string | undefined): string | undefined {
  const trimmed = root?.trim();
  return trimmed ? trimmed : undefined;
}
