import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';

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
  family: 'linux',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createLinuxPlatformRuntime } = await import('./runtime.ts');
    return createLinuxPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

export const inventoryModule: InventoryPlatformModule<'linux'> = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createLinuxInventory } = await import('./inventory.ts');
    return createLinuxInventory(host);
  },
});

export type { LinuxToolProvider } from './tool-provider.ts';

export const openLinuxApp = deferred<(typeof import('./app-lifecycle.ts'))['openLinuxApp']>(
  async () => (await import('./app-lifecycle.ts')).openLinuxApp,
);
export const closeLinuxApp = deferred<(typeof import('./app-lifecycle.ts'))['closeLinuxApp']>(
  async () => (await import('./app-lifecycle.ts')).closeLinuxApp,
);
export const backLinux = deferred<(typeof import('./app-lifecycle.ts'))['backLinux']>(
  async () => (await import('./app-lifecycle.ts')).backLinux,
);
export const homeLinux = deferred<(typeof import('./app-lifecycle.ts'))['homeLinux']>(
  async () => (await import('./app-lifecycle.ts')).homeLinux,
);

export const readLinuxClipboard = deferred<(typeof import('./clipboard.ts'))['readLinuxClipboard']>(
  async () => (await import('./clipboard.ts')).readLinuxClipboard,
);
export const writeLinuxClipboard = deferred<
  (typeof import('./clipboard.ts'))['writeLinuxClipboard']
>(async () => (await import('./clipboard.ts')).writeLinuxClipboard);

export const doubleClickLinux = deferred<(typeof import('./input-actions.ts'))['doubleClickLinux']>(
  async () => (await import('./input-actions.ts')).doubleClickLinux,
);
export const fillLinux = deferred<(typeof import('./input-actions.ts'))['fillLinux']>(
  async () => (await import('./input-actions.ts')).fillLinux,
);
export const focusLinux = deferred<(typeof import('./input-actions.ts'))['focusLinux']>(
  async () => (await import('./input-actions.ts')).focusLinux,
);
export const longPressLinux = deferred<(typeof import('./input-actions.ts'))['longPressLinux']>(
  async () => (await import('./input-actions.ts')).longPressLinux,
);
export const pressLinux = deferred<(typeof import('./input-actions.ts'))['pressLinux']>(
  async () => (await import('./input-actions.ts')).pressLinux,
);
export const rightClickLinux = deferred<(typeof import('./input-actions.ts'))['rightClickLinux']>(
  async () => (await import('./input-actions.ts')).rightClickLinux,
);
export const middleClickLinux = deferred<(typeof import('./input-actions.ts'))['middleClickLinux']>(
  async () => (await import('./input-actions.ts')).middleClickLinux,
);
export const scrollLinux = deferred<(typeof import('./input-actions.ts'))['scrollLinux']>(
  async () => (await import('./input-actions.ts')).scrollLinux,
);
export const swipeLinux = deferred<(typeof import('./input-actions.ts'))['swipeLinux']>(
  async () => (await import('./input-actions.ts')).swipeLinux,
);
export const typeLinux = deferred<(typeof import('./input-actions.ts'))['typeLinux']>(
  async () => (await import('./input-actions.ts')).typeLinux,
);

export const screenshotLinux = deferred<(typeof import('./screenshot.ts'))['screenshotLinux']>(
  async () => (await import('./screenshot.ts')).screenshotLinux,
);
export const captureLinuxSurfaceSnapshot = deferred<
  (typeof import('./surface-snapshot.ts'))['captureLinuxSurfaceSnapshot']
>(async () => (await import('./surface-snapshot.ts')).captureLinuxSurfaceSnapshot);
export const readLinuxTextAtPoint = deferred<
  (typeof import('./snapshot.ts'))['readLinuxTextAtPoint']
>(async () => (await import('./snapshot.ts')).readLinuxTextAtPoint);
export const createLocalLinuxToolProvider = deferred<
  (typeof import('./tool-provider.ts'))['createLocalLinuxToolProvider']
>(async () => (await import('./tool-provider.ts')).createLocalLinuxToolProvider);

export async function withLinuxToolProvider<T>(
  provider: import('./tool-provider.ts').LinuxToolProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const { withLinuxToolProvider: implementation } = await import('./tool-provider.ts');
  return await implementation(provider, fn);
}
