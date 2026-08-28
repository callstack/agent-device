import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type { HarmonyInventoryConfig } from './inventory-config.ts';

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
  family: 'harmonyos',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createHarmonyPlatformRuntime } = await import('./runtime.ts');
    return createHarmonyPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

export type { HarmonyInventoryConfig } from './inventory-config.ts';

export const listHarmonyApps = deferred<(typeof import('./app-lifecycle.ts'))['listHarmonyApps']>(
  async () => (await import('./app-lifecycle.ts')).listHarmonyApps,
);
export const openHarmonyApp = deferred<(typeof import('./app-lifecycle.ts'))['openHarmonyApp']>(
  async () => (await import('./app-lifecycle.ts')).openHarmonyApp,
);
export const closeHarmonyApp = deferred<(typeof import('./app-lifecycle.ts'))['closeHarmonyApp']>(
  async () => (await import('./app-lifecycle.ts')).closeHarmonyApp,
);

export const runHarmonyHdc = deferred<(typeof import('./hdc.ts'))['runHarmonyHdc']>(
  async () => (await import('./hdc.ts')).runHarmonyHdc,
);
export const ensureHarmonyToolchainPathConfigured = deferred<
  (typeof import('./hdc.ts'))['ensureHarmonyToolchainPathConfigured']
>(async () => (await import('./hdc.ts')).ensureHarmonyToolchainPathConfigured);

export const pressHarmony = deferred<(typeof import('./input-actions.ts'))['pressHarmony']>(
  async () => (await import('./input-actions.ts')).pressHarmony,
);
export const doubleClickHarmony = deferred<
  (typeof import('./input-actions.ts'))['doubleClickHarmony']
>(async () => (await import('./input-actions.ts')).doubleClickHarmony);
export const longPressHarmony = deferred<(typeof import('./input-actions.ts'))['longPressHarmony']>(
  async () => (await import('./input-actions.ts')).longPressHarmony,
);
export const typeHarmony = deferred<(typeof import('./input-actions.ts'))['typeHarmony']>(
  async () => (await import('./input-actions.ts')).typeHarmony,
);
export const fillHarmony = deferred<(typeof import('./input-actions.ts'))['fillHarmony']>(
  async () => (await import('./input-actions.ts')).fillHarmony,
);
export const scrollHarmony = deferred<(typeof import('./input-actions.ts'))['scrollHarmony']>(
  async () => (await import('./input-actions.ts')).scrollHarmony,
);
export const performHarmonyGesture = deferred<
  (typeof import('./input-actions.ts'))['performHarmonyGesture']
>(async () => (await import('./input-actions.ts')).performHarmonyGesture);
export const backHarmony = deferred<(typeof import('./input-actions.ts'))['backHarmony']>(
  async () => (await import('./input-actions.ts')).backHarmony,
);
export const homeHarmony = deferred<(typeof import('./input-actions.ts'))['homeHarmony']>(
  async () => (await import('./input-actions.ts')).homeHarmony,
);
export const appSwitcherHarmony = deferred<
  (typeof import('./input-actions.ts'))['appSwitcherHarmony']
>(async () => (await import('./input-actions.ts')).appSwitcherHarmony);
export const pressHarmonyKeyboardKey = deferred<
  (typeof import('./input-actions.ts'))['pressHarmonyKeyboardKey']
>(async () => (await import('./input-actions.ts')).pressHarmonyKeyboardKey);
export const setHarmonyOrientation = deferred<
  (typeof import('./input-actions.ts'))['setHarmonyOrientation']
>(async () => (await import('./input-actions.ts')).setHarmonyOrientation);

export const screenshotHarmony = deferred<(typeof import('./screenshot.ts'))['screenshotHarmony']>(
  async () => (await import('./screenshot.ts')).screenshotHarmony,
);
export const setHarmonySetting = deferred<(typeof import('./settings.ts'))['setHarmonySetting']>(
  async () => (await import('./settings.ts')).setHarmonySetting,
);
export const snapshotHarmony = deferred<(typeof import('./snapshot.ts'))['snapshotHarmony']>(
  async () => (await import('./snapshot.ts')).snapshotHarmony,
);
export const readHarmonyGestureViewport = deferred<
  (typeof import('./snapshot.ts'))['readHarmonyGestureViewport']
>(async () => (await import('./snapshot.ts')).readHarmonyGestureViewport);
export const sampleHarmonyMemoryPerf = deferred<
  (typeof import('./perf.ts'))['sampleHarmonyMemoryPerf']
>(async () => (await import('./perf.ts')).sampleHarmonyMemoryPerf);
export const harmonyToolchainCheck = deferred<
  (typeof import('./doctor.ts'))['harmonyToolchainCheck']
>(async () => (await import('./doctor.ts')).harmonyToolchainCheck);

export function createHarmonyInventoryModule(
  config: HarmonyInventoryConfig,
): InventoryPlatformModule<'harmonyos'> {
  const capturedConfig = Object.freeze({
    hdcSdkPath: normalizedRoot(config.hdcSdkPath),
    devecoSdkHome: normalizedRoot(config.devecoSdkHome),
    commandLineToolsHome: normalizedRoot(config.commandLineToolsHome),
  });
  return Object.freeze({
    ...metadata,
    loadInventory: async (host) => {
      const { createHarmonyInventory } = await import('./inventory.ts');
      return createHarmonyInventory(host, capturedConfig);
    },
  });
}

function normalizedRoot(root: string | undefined): string | undefined {
  const trimmed = root?.trim();
  return trimmed ? trimmed : undefined;
}
