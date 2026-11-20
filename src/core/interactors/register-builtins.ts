import type { RunnerContext } from '@agent-device/contracts/interactor-types';
import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';
import type {
  RequiredPlatform,
  createPlatformModuleRegistry,
} from '@agent-device/contracts/platform-module';
import {
  registerPlatformPluginSet,
  type PlatformPluginAbsence,
} from '../platform-plugin-registry.ts';
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
] as const satisfies readonly PlatformPlugin[];

// The leaf platforms covered by at least one builtin plugin, recovered from the
// preserved literal `platforms` tuples.
type CoveredPlatform = (typeof BUILTIN_PLATFORM_PLUGINS)[number]['platforms'][number];

/**
 * The registry counterpart of the deleted `getInteractor` switch's exhaustive `never` default: a
 * new required family (ADR 0034: `apple`, `android`) added to `REQUIRED_PLATFORMS` without a plugin
 * makes `RequiredPlatform` no longer extend `CoveredPlatform`, so the alias resolves to `false` and
 * the build fails. Optional families may be absent — they move into `platform` plugins — so they
 * are deliberately not required here.
 */
type AssertTrue<T extends true> = T;
/** Exported only so `noUnusedLocals` keeps the guard alive. */
export type BuiltinPluginsCoverRequiredPlatforms = AssertTrue<
  [RequiredPlatform] extends [CoveredPlatform] ? true : false
>;

let registered = false;

/**
 * Composes every builtin plugin into the shared registry exactly once (idempotent), and gives the
 * registry the builtin set's absence reporter as one input. Called at the top of `core/interactors.ts`
 * so the registry is populated before any `getPlugin` lookup; safe to call again from tests.
 * `reportAbsent` is how the registry reports a family the builtin set does not own, so the caller
 * decides which core's plugin release an installation hint names (ADR 0034). It belongs to the set —
 * not to a plugin — so no plugin can swap this process's absence policy.
 */
export function registerBuiltinPlatformPlugins(
  reportAbsent: PlatformPluginAbsence,
  createRegistry: typeof createPlatformModuleRegistry,
): void {
  if (registered) return;
  registerPlatformPluginSet(BUILTIN_PLATFORM_PLUGINS, reportAbsent, createRegistry);
  registered = true;
}
