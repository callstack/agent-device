import type {
  ProviderDeviceInventorySource,
  ProviderDeviceRuntime,
} from '@agent-device/contracts/device';
import {
  createPlatformModuleRegistry,
  type AppLogRuntimeOperations,
  type AppLogRuntimePlatformModule,
  type AppLogSessionArtifacts,
  type ComposedDeviceInventoryGateways,
  type DeviceRuntimeGateway,
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
import {
  createComposedAppLogRuntimeGateway,
  type AppLogRuntimeProviderRegistration,
} from './platform-runtime-app-log.ts';
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

const appLogRuntimeModules: ReadonlyMap<Platform, AppLogRuntimePlatformModule> = new Map<
  Platform,
  AppLogRuntimePlatformModule
>([
  ['apple', appleRuntimeModule],
  ['android', androidRuntimeModule],
  ['harmonyos', harmonyosRuntimeModule],
  ['vega', vegaRuntimeModule],
  ['linux', linuxRuntimeModule],
  ['web', webRuntimeModule],
]);

type Platform = AppLogRuntimePlatformModule['family'];

export function createPlatformAppLogRuntimeGateway(
  options: Readonly<{
    providerRuntimes?: readonly ProviderDeviceRuntime[];
    providerModules?: readonly AppLogRuntimeProviderRegistration[];
    resolveSessionArtifacts(sessionId: string): AppLogSessionArtifacts;
    sessionsDir: string;
  }>,
): DeviceRuntimeGateway<AppLogRuntimeOperations> {
  return createComposedAppLogRuntimeGateway({
    modules: appLogRuntimeModules,
    loadHost: async () => {
      const { createAppLogRuntimeHost } = await import('./platform-runtime-app-log-host.ts');
      return createAppLogRuntimeHost({
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
