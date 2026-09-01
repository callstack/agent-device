import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import type { RunnerContext } from '@agent-device/contracts/interactor-types';
import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';

const metadata = Object.freeze({
  family: 'apple',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createApplePlatformRuntime } = await import('./runtime.ts');
    return createApplePlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

export const inventoryModule = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createAppleInventorySource } = await import('./inventory.ts');
    return createAppleInventorySource(host);
  },
} satisfies InventoryPlatformModule<'apple'>);

export async function loadShutdownRuntime(
  dependencies: Pick<DeviceShutdownRuntimeDependencies, 'appleTools'>,
) {
  const { createAppleShutdownRuntime } = await import('./shutdown/runtime.ts');
  return createAppleShutdownRuntime(dependencies);
}

export const applePlugin = {
  id: 'apple',
  platforms: ['apple'],
  familySelector: 'apple',
  providers: { platformGatedResolvers: ['appleRunnerProvider', 'appleToolProvider'] },
  createInteractor: async (device: DeviceInfo, runner: RunnerContext) => {
    const { createAppleInteractor } = await import('./interactor.ts');
    return createAppleInteractor(device, runner);
  },
} as const satisfies PlatformPlugin;
