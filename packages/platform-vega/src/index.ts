import type { PlatformContribution, PlatformHost } from 'agent-device/plugins';
import type { VegaToolbox } from './toolbox.ts';
import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type { VegaPlatformRegistration } from '@agent-device/contracts/platform-plugin';

const metadata = Object.freeze({
  family: 'vega',
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
function vegaToolbox(host: PlatformHost) {
  let toolbox: Promise<VegaToolbox> | undefined;
  return async () =>
    (toolbox ??= (toolboxModule ??= import('./toolbox.ts')).then(({ createVegaToolbox }) =>
      createVegaToolbox(host),
    ));
}

function vegaPlatformPlugin() {
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'platform',
        family: 'vega',
        // Importing this package evaluates nothing but itself, and the host is bound to a toolbox
        // only when an operation first needs one. Every operation below asks the same lazy
        // resolution, so one setup builds exactly one toolbox for the whole family.
        setup(host: PlatformHost): VegaPlatformRegistration {
          const toolbox = vegaToolbox(host);
          const inventoryModule: InventoryPlatformModule<'vega'> = Object.freeze({
            ...metadata,
            // The family's inventory asks the core for no host: the CLI it resolves comes from the
            // host `setup` received, so the plugin neither searches `PATH` nor reads the process home
            // by itself (ADR 0019).
            loadInventory: async () => {
              const [{ createVegaInventory }, { commands }] = await Promise.all([
                import('./inventory.ts'),
                toolbox(),
              ]);
              return createVegaInventory(commands);
            },
          });
          const runtimeModule = Object.freeze({
            ...metadata,
            loadRuntime: async (host) => {
              const { createVegaPlatformRuntime } = await import('./runtime.ts');
              return createVegaPlatformRuntime(host);
            },
          } satisfies PlatformRuntimeModule & { readonly family: 'vega' });
          return {
            family: 'vega',
            inventoryModule,
            runtimeModule,
            createInteractor: async (device, runnerContext) => {
              const [{ createVegaInteractor }, { commands }, toolProvider] = await Promise.all([
                import('./interactor.ts'),
                toolbox(),
                import('./tool-provider.ts'),
              ]);
              const { withMethodScope } = await import('@agent-device/kernel/scoped-provider');
              // The interactor binds the CLI provider to the host this plugin was set up with. A
              // request-scoped provider still wins: this one enters only when the request scopes none.
              const provider = toolProvider.createVegaToolProvider(commands);
              const interactor = createVegaInteractor(device, runnerContext);
              return withMethodScope(interactor, async (task) =>
                toolProvider.hasScopedVegaToolProvider()
                  ? await task()
                  : await toolProvider.withVegaToolProvider(provider, task),
              );
            },
            withRequestProvider: async (provider, task) => {
              const { withVegaToolProvider } = await import('./tool-provider.ts');
              return await withVegaToolProvider(provider, task);
            },
            operations: {
              toolchainCheck: async (context) => {
                const [{ vegaToolchainCheck }, { commands }] = await Promise.all([
                  import('./doctor.ts'),
                  toolbox(),
                ]);
                return await vegaToolchainCheck(context, commands);
              },
            },
          };
        },
      },
    ],
  } satisfies {
    apiVersion: 3;
    contributes: [Extract<PlatformContribution, { family: 'vega' }>];
  };
}

export { vegaPlatformPlugin as default };
