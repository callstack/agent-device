import type { RunnerContext } from '@agent-device/contracts/interactor-types';
import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';
import type { RequiredPlatform } from '@agent-device/contracts/platform-module';
import { applePlugin } from '@agent-device/platform-apple';
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

/**
 * The builtin plugins, in `PLATFORMS` order so `registeredPlatforms()` derives
 * the canonical tuple's order (asserted by the parity test).
 */
export const BUILTIN_PLATFORM_PLUGINS = [
  applePlugin,
  androidPlugin,
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
