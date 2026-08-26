import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type { HarmonyInventoryConfig } from './inventory-config.ts';

const metadata = Object.freeze({
  family: 'harmonyos',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createHarmonyPlatformRuntime } = await import('./runtime.ts');
    return createHarmonyPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

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
