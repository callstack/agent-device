import type { RunnerContext } from '@agent-device/contracts/interactor-types';
import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';
import type { RequiredPlatform } from '@agent-device/contracts/platform-module';
import { registerPlatformPlugin } from '../platform-plugin-registry.ts';
import { applePlugin } from '@agent-device/platform-apple';
import { vegaPlugin } from '@agent-device/platform-vega';
import type { DeviceInfo } from '@agent-device/kernel/device';

const androidPlugin = {
  id: 'android',
  platforms: ['android'],
  // Declares the platform-gated request provider resolver the Android family owns (the
  // adb provider, formerly gated by `device.platform === 'android'`).
  providers: { platformGatedResolvers: ['androidAdbProvider'] },
  createInteractor: async (device: DeviceInfo, runner: RunnerContext) => {
    const { createAndroidInteractor } = await import('./android.ts');
    return createAndroidInteractor(device, undefined, runner);
  },
} as const satisfies PlatformPlugin;

const harmonyosPlugin = {
  id: 'harmonyos',
  platforms: ['harmonyos'],
  createInteractor: async (device: DeviceInfo, runner: RunnerContext) => {
    const { createHarmonyInteractor } = await import('@agent-device/platform-harmonyos/interactor');
    return createHarmonyInteractor(device, runner);
  },
} as const satisfies PlatformPlugin;

const linuxPlugin = {
  id: 'linux',
  platforms: ['linux'],
  // Declares the platform-gated request provider resolver the linux family owns (the
  // linux tool provider, formerly gated by `device.platform === 'linux'`).
  providers: { platformGatedResolvers: ['linuxToolProvider'] },
  createInteractor: async (_device, _runner, host) => {
    const { createLinuxInteractor } = await import('@agent-device/platform-linux/interactor');
    return createLinuxInteractor(host);
  },
} as const satisfies PlatformPlugin;

const webPlugin = {
  id: 'web',
  platforms: ['web'],
  // Declares the platform-gated request provider resolver the web family owns (the web
  // provider, formerly gated by `device.platform === 'web'`).
  providers: { platformGatedResolvers: ['webProvider'] },
  createInteractor: async (_device, _runner, host) => {
    const { createWebInteractor } = await import('@agent-device/platform-web/interactor');
    return await createWebInteractor(host);
  },
} as const satisfies PlatformPlugin;

/**
 * The builtin plugins, in `PLATFORMS` order so `registeredPlatforms()` derives
 * the canonical tuple's order (asserted by the parity test).
 */
export const BUILTIN_PLATFORM_PLUGINS = [
  applePlugin,
  androidPlugin,
  harmonyosPlugin,
  vegaPlugin,
  linuxPlugin,
  webPlugin,
] as const satisfies readonly PlatformPlugin[];

// The leaf platforms covered by at least one builtin plugin, recovered from the
// preserved literal `platforms` tuples.
type CoveredPlatform = (typeof BUILTIN_PLATFORM_PLUGINS)[number]['platforms'][number];

/**
 * Compile-time EXHAUSTIVENESS: a new required platform family (ADR 0034: `apple` and
 * `android`) added to `REQUIRED_PLATFORMS` without a plugin makes `RequiredPlatform` no
 * longer extend `CoveredPlatform`, so this alias resolves to `false`, violating the
 * `extends true` constraint and failing the build. Optional families (`harmonyos`,
 * `vega`, `linux`, `web`) may be absent — they move into `platform` plugins — so they are
 * deliberately not required here. This is the registry counterpart of the deleted
 * `getInteractor` switch's exhaustive `never` default. (Equivalent in spirit to an
 * `Object.fromEntries(registeredPlatforms()...) satisfies Record<RequiredPlatform, true>`
 * sketch, but type-level so it cannot be satisfied vacuously by a runtime map.)
 */
type AssertTrue<T extends true> = T;
/** Exported only so `noUnusedLocals` keeps the guard alive. */
export type BuiltinPluginsCoverRequiredPlatforms = AssertTrue<
  [RequiredPlatform] extends [CoveredPlatform] ? true : false
>;

let registered = false;

/**
 * Registers every builtin plugin into the shared registry exactly once
 * (idempotent). Called at the top of `core/interactors.ts` so the registry is
 * populated before any `getPlugin` lookup; safe to call again from tests.
 */
export function registerBuiltinPlatformPlugins(): void {
  if (registered) return;
  for (const plugin of BUILTIN_PLATFORM_PLUGINS) {
    registerPlatformPlugin(plugin);
  }
  registered = true;
}
