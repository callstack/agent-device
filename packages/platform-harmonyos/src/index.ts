import type { PlatformContribution, PlatformHost, PlatformSetup } from 'agent-device/plugins';
import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';

const metadata = Object.freeze({
  family: 'harmonyos',
} satisfies PlatformModuleMetadata);

const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createHarmonyPlatformRuntime } = await import('./runtime.ts');
    return createHarmonyPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

/**
 * Builds the inventory module from the host the plugin was set up with. The documented HarmonyOS
 * toolchain roots are read there, so a daemon started with them picks them up without the core
 * naming HarmonyOS configuration, and the plugin never reads `process.env` itself (ADR 0019).
 */
function createHarmonyInventoryModule(host: HostEnvironment): InventoryPlatformModule<'harmonyos'> {
  const config = Object.freeze({
    hdcSdkPath: normalizedRoot(host.env.HDC_SDK_PATH),
    devecoSdkHome: normalizedRoot(host.env.DEVECO_SDK_HOME),
    commandLineToolsHome: normalizedRoot(host.env.HARMONYOS_COMMAND_LINE_TOOLS),
  });
  return Object.freeze({
    ...metadata,
    loadInventory: async (inventoryHost) => {
      const { createHarmonyInventory } = await import('./inventory.ts');
      return createHarmonyInventory(inventoryHost, config);
    },
  });
}

function normalizedRoot(root: string | undefined): string | undefined {
  const trimmed = root?.trim();
  return trimmed ? trimmed : undefined;
}

function harmonyPlatformPlugin() {
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'platform',
        family: 'harmonyos',
        setup(host: PlatformHost): PlatformSetup<'harmonyos'> {
          return {
            family: 'harmonyos',
            inventoryModule: createHarmonyInventoryModule(host),
            runtimeModule,
            createInteractor: async (
              device: DeviceInfo,
              runnerContext: RunnerContext,
            ): Promise<Interactor> => {
              const { createHarmonyInteractor } = await import('./interactor.ts');
              return createHarmonyInteractor(device, runnerContext);
            },
            operations: {
              toolchainCheck: async () => {
                const { harmonyToolchainCheck } = await import('./doctor.ts');
                return await harmonyToolchainCheck();
              },
              prepareToolchain: async (env: EnvMap) => {
                const { ensureHarmonyToolchainPathConfigured } = await import('./hdc.ts');
                await ensureHarmonyToolchainPathConfigured(env);
              },
            },
          };
        },
      },
    ],
  } satisfies {
    apiVersion: 3;
    contributes: [Extract<PlatformContribution, { family: 'harmonyos' }>];
  };
}

export { harmonyPlatformPlugin as default };
