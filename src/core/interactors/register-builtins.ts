import type { RunnerContext } from '@agent-device/contracts/interaction';
import type { PlatformPlugin } from '@agent-device/contracts/platform';
import { registerPlatformPlugin } from '../platform-plugin-registry.ts';
import { applePlugin } from '../../platforms/apple/plugin.ts';
import { vegaPlugin } from '../../platforms/vega/plugin.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { isAudioProbeSupportedDevice } from '@agent-device/contracts/platform';
import type { Platform, DeviceInfo } from '@agent-device/kernel/device';

// The builtin-plugin wiring lives at the interactor seam (src/core/interactors/) —
// the one place R3 (see scripts/layering/check.ts) permits a STATIC value import of
// `platforms/`, so this module can pull the relocated `applePlugin`
// (src/platforms/apple/plugin.ts) into the registry while the generic registry + type
// stay in `core/` (src/core/platform-plugin/plugin.ts) where non-interactor core code
// like `core/capabilities.ts` may import them. The Apple plugin instance and its
// capability closures now live under `platforms/apple/`; the android/linux/web wiring
// stays here. Each plugin WRAPS today's existing interactor factories lazily.
// `as const satisfies PlatformPlugin` preserves each plugin's literal `platforms` tuple
// so the totality assertion below is a real compile-time check.

const androidPlugin = {
  id: 'android',
  platforms: ['android'],
  capability: {
    bucket: 'android',
    supportsByDefault: {
      [PUBLIC_COMMANDS.audio]: isAudioProbeSupportedDevice,
      [PUBLIC_COMMANDS.tvRemote]: (device) => device.target === 'tv',
    },
    unsupportedHintByDefault: {
      [PUBLIC_COMMANDS.tvRemote]: (device) =>
        device.target === 'tv' ? undefined : 'tv-remote is supported only on Android TV targets.',
    },
  },
  // Android exposes explicit frame-health and memory observations.
  perf: { supportsObservations: () => true },
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
  capability: { bucket: 'harmonyos' },
  perf: { supportsObservations: () => true },
  createInteractor: async (device: DeviceInfo, runner: RunnerContext) => {
    const { createHarmonyInteractor } = await import('./harmonyos.ts');
    return createHarmonyInteractor(device, runner);
  },
} as const satisfies PlatformPlugin;

const linuxPlugin = {
  id: 'linux',
  platforms: ['linux'],
  capability: { bucket: 'linux' },
  // Declares the platform-gated request provider resolver the linux family owns (the
  // linux tool provider, formerly gated by `device.platform === 'linux'`).
  providers: { platformGatedResolvers: ['linuxToolProvider'] },
  createInteractor: async () => {
    const { createLinuxInteractor } = await import('./linux.ts');
    return createLinuxInteractor();
  },
} as const satisfies PlatformPlugin;

const webPlugin = {
  id: 'web',
  platforms: ['web'],
  capability: { bucket: 'web' },
  // Declares the platform-gated request provider resolver the web family owns (the web
  // provider, formerly gated by `device.platform === 'web'`).
  providers: { platformGatedResolvers: ['webProvider'] },
  createInteractor: async () => {
    const { createWebInteractor } = await import('./web.ts');
    return createWebInteractor();
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
 * Compile-time EXHAUSTIVENESS: a new `Platform` literal added to `PLATFORMS`
 * without a plugin makes `Platform` no longer extend `CoveredPlatform`, so this
 * alias resolves to `false`, violating the `extends true` constraint and failing
 * the build. This is the registry counterpart of the deleted `getInteractor`
 * switch's exhaustive `never` default. (Equivalent in spirit to an
 * `Object.fromEntries(registeredPlatforms()...) satisfies Record<Platform, true>`
 * sketch, but type-level so it cannot be satisfied vacuously by a runtime map.)
 */
type AssertTrue<T extends true> = T;
/** Exported only so `noUnusedLocals` keeps the guard alive. */
export type BuiltinPluginsCoverAllPlatforms = AssertTrue<
  [Platform] extends [CoveredPlatform] ? true : false
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
