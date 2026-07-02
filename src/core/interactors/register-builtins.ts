import { registerPlatformPlugin, type PlatformPlugin } from '../platform-plugin/plugin.ts';
import { applePlugin } from '../../platforms/apple/plugin.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { isAudioProbeSupportedDevice } from '../../kernel/audio-probe-support.ts';
import { WEB_DESKTOP_DEVICE } from '../platform-inventory.ts';
import type { Platform, DeviceInfo } from '../../kernel/device.ts';
import type { DeviceInventoryRequest } from '../platform-inventory.ts';

// The builtin-plugin wiring lives at the interactor seam (src/core/interactors/) —
// the one place R3 (see scripts/layering/check.ts) permits a STATIC value import of
// `platforms/`, so this module can pull the relocated `applePlugin`
// (src/platforms/apple/plugin.ts) into the registry while the generic registry + type
// stay in `core/` (src/core/platform-plugin/plugin.ts) where non-interactor core code
// like `core/capabilities.ts` may import them. The Apple plugin instance and its
// capability closures now live under `platforms/apple/`; the android/linux/web wiring
// stays here. Each plugin WRAPS today's existing factories (src/core/interactors/*) and
// the inventory if-chain (src/core/platform-inventory.ts) as LAZY methods: the dynamic
// `import()`s and per-platform list calls are byte-for-byte the same as the
// hand-authored `getInteractor` switch arms and `listLocalDeviceInventory` branches.
// `as const satisfies PlatformPlugin` preserves each plugin's literal `platforms` tuple
// so the totality assertion below is a real compile-time check.

const androidPlugin = {
  id: 'android',
  platforms: ['android'],
  capability: {
    bucket: 'android',
    supportsByDefault: { [PUBLIC_COMMANDS.audio]: isAudioProbeSupportedDevice },
  },
  // Wraps the Android arm of `resolveLogBackend`: every Android device -> 'android'.
  appLog: { resolveBackend: () => 'android' },
  // Wraps the Android arm of `supportsPlatformPerfMetrics`: every Android device
  // reports perf-metrics support.
  perf: { supportsMetrics: () => true },
  // Wraps the Android arm of `resolveRecordingBackendForDevice`: every Android device
  // resolves to the android recording backend.
  recording: { resolveBackendTag: () => 'android' },
  // Declares the platform-gated request provider resolver the Android family owns (the
  // adb provider, formerly gated by `device.platform === 'android'`).
  providers: { platformGatedResolvers: ['androidAdbProvider'] },
  createInteractor: async (device: DeviceInfo) => {
    const { createAndroidInteractor } = await import('./android.ts');
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
  // No recording facet: linux historically fell through to the unsupported recording
  // backend; the daemon lookup preserves that (`?? 'unsupported'`).
  // Declares the platform-gated request provider resolver the linux family owns (the
  // linux tool provider, formerly gated by `device.platform === 'linux'`).
  providers: { platformGatedResolvers: ['linuxToolProvider'] },
  createInteractor: async () => {
    const { createLinuxInteractor } = await import('./linux.ts');
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
  // Wraps the web arm of `resolveRecordingBackendForDevice`: the web device resolves to
  // the web (agent-browser) recording backend.
  recording: { resolveBackendTag: () => 'web' },
  // Declares the platform-gated request provider resolver the web family owns (the web
  // provider, formerly gated by `device.platform === 'web'`).
  providers: { platformGatedResolvers: ['webProvider'] },
  createInteractor: async () => {
    const { createWebInteractor } = await import('./web.ts');
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
 * switch's exhaustive `never` default. (Equivalent in spirit to an
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
