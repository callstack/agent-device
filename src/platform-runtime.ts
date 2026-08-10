import type { ProviderDeviceInventorySource } from '@agent-device/contracts/device';
import {
  createPlatformModuleRegistry,
  type ComposedDeviceInventoryGateways,
} from '@agent-device/contracts/platform';
import { inventoryModule as appleInventoryModule } from '@agent-device/platform-apple';
import { createAndroidInventoryModule } from '@agent-device/platform-android';
import { createHarmonyInventoryModule } from '@agent-device/platform-harmonyos';
import { inventoryModule as vegaInventoryModule } from '@agent-device/platform-vega';
import { inventoryModule as linuxInventoryModule } from '@agent-device/platform-linux';
import { inventoryModule as webInventoryModule } from '@agent-device/platform-web';
import { createComposedDeviceInventoryGateways } from './platform-runtime-device-inventory.ts';

const androidInventoryModule = createAndroidInventoryModule({
  sdkRoots: configuredValues(process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME),
});

const harmonyosInventoryModule = createHarmonyInventoryModule({
  hdcSdkPath: process.env.HDC_SDK_PATH,
  devecoSdkHome: process.env.DEVECO_SDK_HOME,
  commandLineToolsHome: process.env.HARMONYOS_COMMAND_LINE_TOOLS,
});

export const platformModuleRegistry = createPlatformModuleRegistry([
  appleInventoryModule,
  androidInventoryModule,
  harmonyosInventoryModule,
  vegaInventoryModule,
  linuxInventoryModule,
  webInventoryModule,
]);

export function createPlatformDeviceInventoryGateways(
  provider?: ProviderDeviceInventorySource,
): ComposedDeviceInventoryGateways {
  return createComposedDeviceInventoryGateways({
    registry: platformModuleRegistry,
    loadHost: async () => {
      const { createDeviceInventoryHost } = await import('./platform-runtime-host.ts');
      return createDeviceInventoryHost();
    },
    provider,
  });
}

function configuredValues(...values: Array<string | undefined>): string[] {
  return values.flatMap((value) => {
    const configured = value?.trim();
    return configured ? [configured] : [];
  });
}
