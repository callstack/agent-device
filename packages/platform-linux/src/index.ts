import type { PlatformContribution, PlatformHost } from 'agent-device/plugins';
import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type {
  LinuxPlatformOperations,
  LinuxPlatformRegistration,
} from '@agent-device/contracts/platform-plugin';
import type { LinuxToolbox } from './toolbox.ts';
import type { LinuxToolProvider } from '@agent-device/contracts/linux-tool-provider';

const metadata = Object.freeze({
  family: 'linux',
} satisfies PlatformModuleMetadata);

/**
 * The toolbox module, resolved exactly once per process. The façade must stay metadata-eager
 * (ADR-0019), so the module that binds a host's command port enters with the first operation that
 * needs it rather than above it. Only the module is memoized: each `setup` call binds its own host.
 */
let toolboxModule: Promise<typeof import('./toolbox.ts')> | undefined;

/**
 * A bound toolbox and the provider built on it, made on first use and then reused: a `setup` that
 * never runs a command imports and builds nothing, and the operations of one setup share the one
 * route it binds its host to.
 */
function linuxToolbox(host: PlatformHost) {
  let bound: Promise<Readonly<{ toolbox: LinuxToolbox; provider: LinuxToolProvider }>> | undefined;
  return async () =>
    (bound ??= (toolboxModule ??= import('./toolbox.ts')).then(async ({ createLinuxToolbox }) => {
      const toolbox = createLinuxToolbox(host);
      const { createLinuxToolProvider } = await import('./tool-provider.ts');
      return Object.freeze({ toolbox, provider: createLinuxToolProvider(toolbox) });
    }));
}

function linuxPlatformPlugin() {
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'platform',
        family: 'linux',
        // Importing this package evaluates nothing but itself, and the host is bound to a toolbox
        // only when an operation first needs one. Every operation below asks the same lazy
        // resolution, so one setup builds exactly one route for the whole family.
        setup(host: PlatformHost): LinuxPlatformRegistration {
          const bind = linuxToolbox(host);
          const inventoryModule: InventoryPlatformModule<'linux'> = Object.freeze({
            ...metadata,
            // The family's inventory asks the core for the host facts it names: an installed plugin
            // reports the one desktop device of a Linux host and nothing anywhere else.
            loadInventory: async (host) => {
              const { createLinuxInventory } = await import('./inventory.ts');
              return createLinuxInventory(host);
            },
          });
          const runtimeModule = Object.freeze({
            ...metadata,
            loadRuntime: async (host) => {
              const { createLinuxPlatformRuntime } = await import('./runtime.ts');
              const { toolbox, provider } = await bind();
              return createLinuxPlatformRuntime(host, toolbox, provider);
            },
          } satisfies PlatformRuntimeModule & { readonly family: 'linux' });
          return {
            family: 'linux',
            inventoryModule,
            runtimeModule,
            createInteractor: async () => {
              const { createLinuxInteractor } = await import('./interactor.ts');
              const { toolbox, provider } = await bind();
              return createLinuxInteractor(toolbox, provider);
            },
            withRequestProvider: async <T>(provider: LinuxToolProvider, task: () => Promise<T>) => {
              const { withLinuxToolProvider } = await import('./tool-provider.ts');
              return await withLinuxToolProvider(provider, task);
            },
            operations: {
              toolchainCheck: async () => {
                const [{ linuxToolchainCheck }, { provider }] = await Promise.all([
                  import('./doctor.ts'),
                  bind(),
                ]);
                return await linuxToolchainCheck(provider);
              },
            } satisfies LinuxPlatformOperations,
          };
        },
      },
    ],
  } satisfies {
    apiVersion: 3;
    contributes: [Extract<PlatformContribution, { family: 'linux' }>];
  };
}

export { linuxPlatformPlugin as default };
