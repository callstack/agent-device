import type {
  ProviderDeviceInventorySource,
  ProviderDeviceRuntime,
} from '@agent-device/contracts/device';
import {
  createPlatformModuleRegistry,
  type AppLogSessionArtifacts,
  type ComposedDeviceInventoryGateways,
  type DeviceRuntimeGateway,
  type PlatformRuntimeModule,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import {
  inventoryModule as appleInventoryModule,
  runtimeModule as appleRuntimeModule,
} from '@agent-device/platform-apple';
import {
  createAndroidInventoryModule,
  runtimeModule as androidRuntimeModule,
} from '@agent-device/platform-android';
import {
  createHarmonyInventoryModule,
  runtimeModule as harmonyosRuntimeModule,
} from '@agent-device/platform-harmonyos';
import {
  inventoryModule as vegaInventoryModule,
  runtimeModule as vegaRuntimeModule,
} from '@agent-device/platform-vega';
import {
  inventoryModule as linuxInventoryModule,
  runtimeModule as linuxRuntimeModule,
} from '@agent-device/platform-linux';
import {
  inventoryModule as webInventoryModule,
  runtimeModule as webRuntimeModule,
} from '@agent-device/platform-web';
import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';
import type { PlatformRuntimeProviderRegistration } from './platform-runtime-gateway.ts';
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

const platformRuntimeModules: ReadonlyMap<Platform, PlatformRuntimeModule> = new Map<
  Platform,
  PlatformRuntimeModule
>([
  ['apple', appleRuntimeModule],
  ['android', androidRuntimeModule],
  ['harmonyos', harmonyosRuntimeModule],
  ['vega', vegaRuntimeModule],
  ['linux', linuxRuntimeModule],
  ['web', webRuntimeModule],
]);

type Platform = PlatformRuntimeModule['family'];

export function createPlatformRuntimeGateway(
  options: Readonly<{
    providerRuntimes?: readonly ProviderDeviceRuntime[];
    providerModules?: readonly PlatformRuntimeProviderRegistration[];
    resolveSessionArtifacts(sessionId: string): AppLogSessionArtifacts;
    sessionsDir: string;
  }>,
): DeviceRuntimeGateway<PlatformRuntimeOperations> {
  return createComposedPlatformRuntimeGateway({
    modules: platformRuntimeModules,
    loadHost: async () => {
      const { createPlatformRuntimeHost } = await import('./platform-runtime-operation-host.ts');
      return createPlatformRuntimeHost({
        sessionsDir: options.sessionsDir,
        resolveSessionArtifacts: options.resolveSessionArtifacts,
      });
    },
    providerRuntimes: options.providerRuntimes,
    providerModules: options.providerModules,
  });
}

function configuredValues(...values: Array<string | undefined>): string[] {
  return values.flatMap((value) => {
    const configured = value?.trim();
    return configured ? [configured] : [];
  });
}
