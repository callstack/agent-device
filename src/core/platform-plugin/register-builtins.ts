import { registerPlatformPlugin, type PlatformPlugin } from './plugin.ts';
import { shouldUseHostMacFastPath, WEB_DESKTOP_DEVICE } from '../platform-inventory.ts';
import type { Platform, DeviceInfo } from '../../kernel/device.ts';
import type { DeviceInventoryRequest } from '../platform-inventory.ts';
import type { RunnerContext } from '../interactor-types.ts';

// Each plugin WRAPS today's existing factories (src/core/interactors/*) and the
// inventory if-chain (src/core/platform-inventory.ts) as LAZY methods. No leaf
// code is rewritten: the dynamic `import()`s and the per-platform list calls are
// byte-for-byte the same as the hand-authored `getInteractor` switch arms and
// `listLocalDeviceInventory` branches. `as const satisfies PlatformPlugin`
// preserves each plugin's literal `platforms` tuple so the totality assertion
// below is a real compile-time check.

const applePlugin = {
  id: 'apple',
  // Apple owns BOTH leaf platforms today — mirrors `case 'ios': case 'macos':`.
  platforms: ['ios', 'macos'],
  familySelector: 'apple',
  capability: { bucket: 'apple' },
  createInteractor: async (device: DeviceInfo, runner: RunnerContext) => {
    const { createAppleInteractor } = await import('../interactors/apple.ts');
    return createAppleInteractor(device, runner);
  },
  // Reproduces the macOS host fast-path + Apple-simulator branch of the
  // inventory if-chain, reusing the SAME predicate (no divergent copy).
  discoverDevices: async (request: DeviceInventoryRequest) => {
    if (shouldUseHostMacFastPath(request)) {
      const { listMacosDevices } = await import('../../platforms/apple/os/macos/devices.ts');
      return await listMacosDevices();
    }
    const { listAppleDevices } = await import('../../platforms/apple/core/devices.ts');
    return await listAppleDevices({
      simulatorSetPath: request.iosSimulatorSetPath,
      udid: request.udid,
    });
  },
} as const satisfies PlatformPlugin;

const androidPlugin = {
  id: 'android',
  platforms: ['android'],
  capability: { bucket: 'android' },
  createInteractor: async (device: DeviceInfo) => {
    const { createAndroidInteractor } = await import('../interactors/android.ts');
    return createAndroidInteractor(device);
  },
  discoverDevices: async (request: DeviceInventoryRequest) => {
    const { listAndroidDevices } = await import('../../platforms/android/devices.ts');
    return await listAndroidDevices({
      serialAllowlist: request.androidSerialAllowlist
        ? new Set(request.androidSerialAllowlist)
        : undefined,
    });
  },
} as const satisfies PlatformPlugin;

const linuxPlugin = {
  id: 'linux',
  platforms: ['linux'],
  capability: { bucket: 'linux' },
  createInteractor: async () => {
    const { createLinuxInteractor } = await import('../interactors/linux.ts');
    return createLinuxInteractor();
  },
  discoverDevices: async () => {
    const { listLinuxDevices } = await import('../../platforms/linux/devices.ts');
    return await listLinuxDevices();
  },
} as const satisfies PlatformPlugin;

const webPlugin = {
  id: 'web',
  platforms: ['web'],
  capability: { bucket: 'web' },
  createInteractor: async () => {
    const { createWebInteractor } = await import('../interactors/web.ts');
    return createWebInteractor();
  },
  // Mirrors the `request.platform === 'web'` branch (the single static device).
  discoverDevices: async () => [WEB_DESKTOP_DEVICE],
} as const satisfies PlatformPlugin;

/**
 * The builtin plugins, in `PLATFORMS` order so `registeredPlatforms()` derives
 * the canonical tuple's order (asserted by the parity test).
 */
export const BUILTIN_PLATFORM_PLUGINS = [
  applePlugin,
  androidPlugin,
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
 * switch's exhaustive `never` default. (Equivalent in spirit to the §5.1
 * `Object.fromEntries(registeredPlatforms()...) satisfies Record<Platform, true>`
 * sketch, but type-level so it cannot be satisfied vacuously by a runtime map.)
 */
type AssertTrue<T extends true> = T;
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
