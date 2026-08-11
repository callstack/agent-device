import type {
  AppStateRuntimeHost,
  AppStateRuntimeResult,
  InventoryPlatformModule,
  PlatformRuntimeModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidInventoryConfig } from './inventory-config.ts';
import type { AndroidAppStateHost } from './app-state.ts';

const metadata = Object.freeze({
  family: 'android',
} satisfies PlatformModuleMetadata);

export type { AndroidInventoryConfig } from './inventory-config.ts';
export type { AndroidAppStateHost } from './app-state.ts';

export async function readAndroidAppState(
  host: AndroidAppStateHost | AppStateRuntimeHost['android'],
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<AppStateRuntimeResult> {
  const { readAndroidAppState: read } = await import('./app-state.ts');
  return await read(host, device, signal);
}

export async function parseAndroidForegroundApp(
  text: string,
): Promise<Readonly<{ package?: string; activity?: string }> | null> {
  const { parseAndroidForegroundApp: parse } = await import('./app-state.ts');
  return parse(text);
}

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createAndroidPlatformRuntime } = await import('./runtime.ts');
    return createAndroidPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

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
