import type {
  ProviderDeviceInventorySource,
  ProviderDeviceRuntime,
} from '@agent-device/contracts/device';
import type { AppLogSessionArtifacts } from '@agent-device/contracts/app-log-runtime';
import type { OwnedProcessRecordWriter } from '@agent-device/contracts/platform-runtime-host';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import {
  type ComposedDeviceInventoryGateways,
  createPlatformModuleRegistry,
} from '@agent-device/contracts/platform-module';
import type { DeviceRuntimeGateway } from '@agent-device/contracts/platform-runtime';
import type {
  PlatformProviderRequestContext,
  RequestPlatformProviderScope,
  RequestPlatformProviders,
} from '@agent-device/contracts/platform-providers';
import type {
  PlatformRuntimeModule,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import {
  inventoryModule as appleInventoryModule,
  loadShutdownRuntime as loadAppleShutdownRuntime,
  runtimeModule as appleRuntimeModule,
} from '@agent-device/platform-apple';
import {
  createAndroidObservationAdapter as createPackageAndroidObservationAdapter,
  createAndroidInventoryModule,
  readAndroidAppStateWithExecutor,
  loadShutdownRuntime as loadAndroidShutdownRuntime,
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
  captureLinuxSurfaceSnapshot,
  inventoryModule as linuxInventoryModule,
  runtimeModule as linuxRuntimeModule,
} from '@agent-device/platform-linux';
import {
  inventoryModule as webInventoryModule,
  runtimeModule as webRuntimeModule,
} from '@agent-device/platform-web';
import {
  createComposedPlatformRuntimeGateway,
  type PlatformRuntimeProviderRegistration,
} from './platform-runtime-gateway.ts';
import { createComposedDeviceInventoryGateways } from './platform-runtime-device-inventory.ts';
import { createAndroidObservationHost } from './platform-runtime-android-observation-host.ts';
import type { RequestPlatformProviderOptions } from './platform-runtime/request-providers.ts';

export type {
  AppleRunnerProviderResolver,
  AppleRunnerScreenRecordingTransportResolver,
  PlatformProviderResolvers,
} from './platform-runtime/request-providers.ts';

export async function getAndroidAppStateWithAdb(
  adb: Parameters<typeof readAndroidAppStateWithExecutor>[0],
  signal?: AbortSignal,
): Promise<AppStateRuntimeResult> {
  return await readAndroidAppStateWithExecutor(adb, signal);
}

const androidInventoryModule = createAndroidInventoryModule({
  sdkRoots: configuredValues(process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME),
});

/** One root-composed Android observer shared by every daemon request. */
export const androidObservation = createPackageAndroidObservationAdapter(
  createAndroidObservationHost(),
);

const shutdownLoaders = Object.freeze({
  apple: async (dependencies: Pick<DeviceShutdownRuntimeDependencies, 'appleTools'>) =>
    await loadAppleShutdownRuntime(dependencies),
  android: async (dependencies: Pick<DeviceShutdownRuntimeDependencies, 'commands'>) =>
    await loadAndroidShutdownRuntime(dependencies),
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

/**
 * Android mechanics call adb through a process-wide host that only this root can bind. Root binds it
 * from two places: this registry entry, which covers everything the Android runtime reaches from
 * inside its own package, and `loadAndroidMechanics`, which covers the root host ports that call
 * into mechanics without ever binding a runtime. Neither one subsumes the other.
 */
const androidRuntimeModuleWithBoundAdbHost: PlatformRuntimeModule = Object.freeze({
  ...androidRuntimeModule,
  loadRuntime: async (host) => {
    await import('./platform-runtime-android-adb-host.ts');
    return await androidRuntimeModule.loadRuntime(host);
  },
});

/** The root composition registry shared by the gateway and bounded host-contract fixtures. */
export const platformRuntimeModules: ReadonlyMap<Platform, PlatformRuntimeModule> = new Map<
  Platform,
  PlatformRuntimeModule
>([
  ['apple', appleRuntimeModule],
  ['android', androidRuntimeModuleWithBoundAdbHost],
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
    ownedProcesses?: OwnedProcessRecordWriter;
  }>,
): DeviceRuntimeGateway<PlatformRuntimeOperations> {
  return createComposedPlatformRuntimeGateway({
    modules: platformRuntimeModules,
    loadHost: async () => {
      const { createPlatformRuntimeHost, createSnapshotRuntimeHost, loadMacOsSurfaceSnapshot } =
        await import('./platform-runtime-operation-host.ts');
      return createPlatformRuntimeHost({
        sessionsDir: options.sessionsDir,
        resolveSessionArtifacts: options.resolveSessionArtifacts,
        shutdownLoaders,
        snapshot: createSnapshotRuntimeHost({
          linux: captureLinuxSurfaceSnapshot,
          macos: loadMacOsSurfaceSnapshot,
        }),
        ownedProcesses: options.ownedProcesses,
      });
    },
    providerRuntimes: options.providerRuntimes,
    providerModules: options.providerModules,
  });
}

/**
 * The canonical root owns request-provider composition as well as device-runtime composition.
 * Its private submodule stays unevaluated until a request actually enters a provider scope, so
 * importing the runtime registry does not load provider or plugin implementations eagerly.
 */
export function createRequestPlatformProviders(
  options: RequestPlatformProviderOptions = {},
): RequestPlatformProviders {
  let composed: Promise<RequestPlatformProviders> | undefined;
  const resolveComposed = (): Promise<RequestPlatformProviders> => {
    composed ??= import('./platform-runtime/request-providers.ts').then(
      ({ createComposedRequestPlatformProviders }) =>
        createComposedRequestPlatformProviders(options),
    );
    return composed;
  };
  return Object.freeze({
    hasConfiguredResolvers: Object.values(options.providers ?? {}).some(Boolean),
    run: async <T>(
      context: PlatformProviderRequestContext,
      task: (scope: RequestPlatformProviderScope) => Promise<T>,
    ): Promise<T> => await (await resolveComposed()).run(context, task),
  });
}

function configuredValues(...values: Array<string | undefined>): string[] {
  return values.flatMap((value) => {
    const configured = value?.trim();
    return configured ? [configured] : [];
  });
}
