import type { PlatformContribution, PlatformSetup } from 'agent-device/plugins';
import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

const metadata = Object.freeze({
  family: 'vega',
} satisfies PlatformModuleMetadata);

const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createVegaPlatformRuntime } = await import('./runtime.ts');
    return createVegaPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

const inventoryModule: InventoryPlatformModule<'vega'> = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createVegaInventory } = await import('./inventory.ts');
    return createVegaInventory(host);
  },
});

function vegaPlatformPlugin() {
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'platform',
        family: 'vega',
        setup(host): PlatformSetup<'vega'> {
          return {
            family: 'vega',
            inventoryModule,
            runtimeModule,
            createInteractor: async (
              device: DeviceInfo,
              runnerContext: RunnerContext,
              host: HostEnvironment,
            ): Promise<Interactor> => {
              const [{ createVegaInteractor }, toolProvider] = await Promise.all([
                import('./interactor.ts'),
                import('./tool-provider.ts'),
              ]);
              // The interactor binds the CLI adapter to the composing runtime's host: executable
              // resolution reads that host's PATH and HOME and memoizes on this instance (#3794). A
              // request-scoped provider still wins: this one enters only when the request scopes none.
              // The entry stays eager-free, so the scope helper arrives with its module, not above it.
              const {
                createLocalVegaCliAdapter,
                createLocalVegaToolProvider,
                hasScopedVegaToolProvider,
                withVegaToolProvider,
              } = toolProvider;
              const provider = createLocalVegaToolProvider(createLocalVegaCliAdapter(host));
              const interactor = createVegaInteractor(device, runnerContext);
              const { withMethodScope } = await import('@agent-device/kernel/scoped-provider');
              return withMethodScope(interactor, async (task) =>
                hasScopedVegaToolProvider()
                  ? await task()
                  : await withVegaToolProvider(provider, task),
              );
            },
            withRequestProvider: async (provider, task) => {
              const { withVegaToolProvider } = await import('./tool-provider.ts');
              return await withVegaToolProvider(provider, task);
            },
            operations: {
              toolchainCheck: async (context) => {
                const { vegaToolchainCheck } = await import('./doctor.ts');
                return await vegaToolchainCheck(context, host);
              },
            },
          };
        },
      },
    ],
  } satisfies { apiVersion: 3; contributes: [Extract<PlatformContribution, { family: 'vega' }>] };
}

export { vegaPlatformPlugin as default };
