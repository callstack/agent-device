import type {
  ProviderDeviceInventorySource,
  ProviderDeviceRuntime,
} from '@agent-device/contracts/device';
import type { AppLogSessionArtifacts } from '@agent-device/contracts/app-log-runtime';
import type {
  HostEnvironment,
  OwnedProcessRecordWriter,
} from '@agent-device/contracts/platform-runtime-host';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import {
  type ComposedDeviceInventoryGateways,
  type InventoryPlatformModule,
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
  createAndroidRuntimeModule,
  readAndroidAppStateWithExecutor,
  loadShutdownRuntime as loadAndroidShutdownRuntime,
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
import { attachAppleSelectionProbes } from './platform-runtime-device-inventory.ts';
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

/** One root-composed Android observer shared by every daemon request. */
export const androidObservation = createPackageAndroidObservationAdapter(
  createAndroidObservationHost(),
);

const shutdownLoaders = Object.freeze({
  apple: async (dependencies: Pick<DeviceShutdownRuntimeDependencies, 'appleTools'>) =>
    await loadAppleShutdownRuntime(dependencies),
  android: async (dependencies: Pick<DeviceShutdownRuntimeDependencies, 'commands' | 'stateDir'>) =>
    await loadAndroidShutdownRuntime(dependencies),
});

// All six families stay registered in the packed core today. The registry completeness-checks only
// the required families, so an optional family (ADR 0034) may be absent from a composition and every
// lookup then reports plugin-not-installed with its install hint. The caller supplies `coreVersion`,
// which that hint names: this root does not read host mechanics.
export function createPlatformModuleRegistryForHost(
  env: Readonly<Record<string, string | undefined>>,
  coreVersion: string,
) {
  return createPlatformModuleRegistry<InventoryPlatformModule>(
    [
      appleInventoryModule,
      createAndroidInventoryModule({
        sdkRoots: configuredValues(env.ANDROID_SDK_ROOT, env.ANDROID_HOME),
      }),
      createHarmonyInventoryModule({
        hdcSdkPath: env.HDC_SDK_PATH,
        devecoSdkHome: env.DEVECO_SDK_HOME,
        commandLineToolsHome: env.HARMONYOS_COMMAND_LINE_TOOLS,
      }),
      vegaInventoryModule,
      linuxInventoryModule,
      webInventoryModule,
    ],
    coreVersion,
  );
}

export async function createPlatformDeviceInventoryGateways(
  host: HostEnvironment,
  coreVersion: string,
  provider?: ProviderDeviceInventorySource,
): Promise<ComposedDeviceInventoryGateways> {
  return await attachAppleSelectionProbes({
    registry: createPlatformModuleRegistryForHost(host.env, coreVersion),
    loadHost: async () => {
      const { createDeviceInventoryHost } = await import('./platform-runtime-host.ts');
      return createDeviceInventoryHost(host);
    },
    provider,
    env: host.env,
  });
}

const androidRuntimeModule = createAndroidRuntimeModule({
  // Evaluating the root's adb host module binds the process-wide port exactly once.
  bindAdbHost: async () => {
    await import('./platform-runtime-android-adb-host.ts');
  },
});

/** The root composition registry the platform runtime gateway reads. All six families are
 * registered today; an optional family absent from a composition fails lookups with the typed
 * `plugin-not-installed` outcome before any device binding (see platform-runtime-gateway.ts). */
function createPlatformRuntimeModuleRegistry(coreVersion: string) {
  return createPlatformModuleRegistry<PlatformRuntimeModule>(
    [
      appleRuntimeModule,
      androidRuntimeModule,
      harmonyosRuntimeModule,
      vegaRuntimeModule,
      linuxRuntimeModule,
      webRuntimeModule,
    ],
    coreVersion,
  );
}

export function createPlatformRuntimeGateway(
  options: Readonly<{
    host: HostEnvironment;
    /** The running core's version, which the typed absence outcome names in its install command. */
    coreVersion: string;
    providerRuntimes?: readonly ProviderDeviceRuntime[];
    providerModules?: readonly PlatformRuntimeProviderRegistration[];
    resolveSessionArtifacts(sessionId: string): AppLogSessionArtifacts;
    stateDir: string;
    sessionsDir: string;
    ownedProcesses?: OwnedProcessRecordWriter;
    assertShutdownAllowed?: () => void;
  }>,
): DeviceRuntimeGateway<PlatformRuntimeOperations> {
  return createComposedPlatformRuntimeGateway({
    modules: createPlatformRuntimeModuleRegistry(options.coreVersion),
    loadHost: async () => {
      const { createPlatformRuntimeHost, createSnapshotRuntimeHost, loadMacOsSurfaceSnapshot } =
        await import('./platform-runtime-operation-host.ts');
      return createPlatformRuntimeHost({
        host: options.host,
        stateDir: options.stateDir,
        sessionsDir: options.sessionsDir,
        resolveSessionArtifacts: options.resolveSessionArtifacts,
        shutdownLoaders,
        assertShutdownAllowed: options.assertShutdownAllowed,
        snapshot: createSnapshotRuntimeHost({
          linux: (snapshotOptions, signal) => captureLinuxSurfaceSnapshot(snapshotOptions, signal),
          macos: (snapshotOptions, signal) =>
            loadMacOsSurfaceSnapshot(snapshotOptions, signal, options.host.env),
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
