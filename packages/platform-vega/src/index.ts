import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';
import type { DeviceInfo } from '@agent-device/kernel/device';

// fallow-ignore-next-line code-duplication
type DeferredFunction = (...args: never[]) => unknown;
type Deferred<Fn extends DeferredFunction> = (
  ...args: Parameters<Fn>
) => Promise<Awaited<ReturnType<Fn>>>;

function deferred<Fn extends DeferredFunction>(load: () => Promise<Fn>): Deferred<Fn> {
  return (async (...args: Parameters<Fn>) =>
    await (
      await load()
    )(...args)) as unknown as Deferred<Fn>;
}

const metadata = Object.freeze({
  family: 'vega',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createVegaPlatformRuntime } = await import('./runtime.ts');
    return createVegaPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

export const inventoryModule: InventoryPlatformModule<'vega'> = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createVegaInventory } = await import('./inventory.ts');
    return createVegaInventory(host);
  },
});

export type { VegaToolProvider } from './tool-provider.ts';

export const vegaPlugin = {
  id: 'vega',
  platforms: ['vega'],
  providers: { platformGatedResolvers: ['vegaToolProvider'] },
  createInteractor: async (
    device: DeviceInfo,
    runnerContext: RunnerContext,
  ): Promise<Interactor> => {
    const { createVegaInteractor } = await import('./interactor.ts');
    return createVegaInteractor(device, runnerContext);
  },
} as const satisfies PlatformPlugin;

export const vegaToolchainCheck = deferred<(typeof import('./doctor.ts'))['vegaToolchainCheck']>(
  async () => (await import('./doctor.ts')).vegaToolchainCheck,
);

export async function withVegaToolProvider<T>(
  provider: import('./tool-provider.ts').VegaToolProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const { withVegaToolProvider: implementation } = await import('./tool-provider.ts');
  return await implementation(provider, fn);
}
