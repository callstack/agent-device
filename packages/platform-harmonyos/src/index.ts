import type { PlatformContribution, PlatformHost } from 'agent-device/plugins';
import type { HarmonyToolbox } from './toolbox.ts';
import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type {
  HarmonyPlatformOperations,
  HarmonyPlatformRegistration,
} from '@agent-device/contracts/platform-plugin';

const metadata = Object.freeze({
  family: 'harmonyos',
} satisfies PlatformModuleMetadata);

/**
 * The toolbox module, resolved exactly once per process. The façade must stay metadata-eager
 * (ADR-0019), so the module that binds a host's command port enters with the first operation that
 * needs it rather than above it. Only the module is memoized: each `setup` call binds its own host.
 */
let toolboxModule: Promise<typeof import('./toolbox.ts')> | undefined;

/**
 * A bound toolbox, made on first use and then reused: a `setup` that never runs a command imports
 * and builds nothing, and the operations of one setup share the one toolbox it binds its host to.
 */
function harmonyToolbox(host: PlatformHost) {
  let toolbox: Promise<HarmonyToolbox> | undefined;
  return async () =>
    (toolbox ??= (toolboxModule ??= import('./toolbox.ts')).then(({ createHarmonyToolbox }) =>
      createHarmonyToolbox(host),
    ));
}

function harmonyPlatformPlugin() {
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'platform',
        family: 'harmonyos',
        // Importing this package evaluates nothing but itself, and the host is bound to a toolbox
        // only when an operation first needs one. Every operation below asks the same lazy
        // resolution, so one setup builds exactly one toolbox for the whole family.
        setup(host: PlatformHost): HarmonyPlatformRegistration {
          const toolbox = harmonyToolbox(host);
          const inventoryModule: InventoryPlatformModule<'harmonyos'> = Object.freeze({
            ...metadata,
            // The family's inventory asks the core for no host: the documented HarmonyOS toolchain
            // roots come from the host `setup` received, so the plugin neither reads `process.env`
            // itself (ADR 0019) nor has the core name its configuration.
            loadInventory: async () => {
              const { createHarmonyInventory } = await import('./inventory.ts');
              return createHarmonyInventory(await toolbox());
            },
          });
          const runtimeModule = Object.freeze({
            ...metadata,
            loadRuntime: async (host) => {
              const { createHarmonyPlatformRuntime } = await import('./runtime.ts');
              return createHarmonyPlatformRuntime(host, await toolbox());
            },
          } satisfies PlatformRuntimeModule & { readonly family: 'harmonyos' });
          return {
            family: 'harmonyos',
            inventoryModule,
            runtimeModule,
            createInteractor: async (device, runnerContext) => {
              const { createHarmonyInteractor } = await import('./interactor.ts');
              return createHarmonyInteractor(await toolbox(), device, runnerContext);
            },
            operations: {
              toolchainCheck: async () => {
                const [{ harmonyToolchainCheck }, { commands }] = await Promise.all([
                  import('./doctor.ts'),
                  toolbox(),
                ]);
                return await harmonyToolchainCheck(commands);
              },
            } satisfies HarmonyPlatformOperations,
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
