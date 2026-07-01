import { registerPlatformPlugin, type PlatformPlugin } from './plugin.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { shouldUseHostMacFastPath, WEB_DESKTOP_DEVICE } from '../platform-inventory.ts';
import type { Platform, DeviceInfo } from '../../kernel/device.ts';
import type { DeviceInventoryRequest } from '../platform-inventory.ts';
import type { RunnerContext } from '../interactor-types.ts';

// ---------------------------------------------------------------------------
// Apple family per-command capability closures — RELOCATED VERBATIM from
// src/core/command-descriptor/registry.ts (ADR-0009 / perfect-shape §7 step b.2:
// relocate, never flatten). Every body below is byte-for-byte the former
// command-facet `supports()` / `unsupportedHint()` closure; the parity gate
// (src/core/__tests__/capability-plugin-routing-parity.test.ts) pins them
// behaviorally against an INDEPENDENT verbatim oracle across the full device
// matrix. Each closure is a no-op (returns `true` / `undefined`) on non-Apple
// devices, so consulting them only for the Apple family leaves admission unchanged.
// ---------------------------------------------------------------------------

const isNotMacOs = (device: DeviceInfo): boolean => device.platform !== 'macos';
const isMacOsOrAppleSimulator = (device: DeviceInfo): boolean =>
  device.platform === 'macos' || device.kind === 'simulator';
const isIosMobileSimulator = (device: DeviceInfo): boolean =>
  device.platform === 'ios' && device.kind === 'simulator' && device.target !== 'tv';
const supportsSynthesisGesture = (device: DeviceInfo): boolean =>
  device.platform === 'android' || isIosMobileSimulator(device);
const supportsAndroidOrIosNonTv = (device: DeviceInfo): boolean =>
  device.platform === 'android' || (device.platform === 'ios' && device.target !== 'tv');

const synthesisGestureUnsupportedHint = (device: DeviceInfo): string | undefined => {
  if (device.platform === 'macos')
    return 'macOS automation has no multi-touch input — this gesture is supported on Android and the iOS simulator only.';
  if (device.platform === 'ios' && device.target === 'tv')
    return 'tvOS has no touch input — this gesture is supported on Android and the iOS simulator only.';
  if (device.platform === 'ios' && device.kind === 'device')
    return 'Two-finger gesture synthesis is iOS-simulator only — not available on physical iOS devices.';
  return undefined;
};

// Per-command support gates the Apple family applies by default, keyed exactly as in
// the command-descriptor registry (a command absent here has no Apple gate).
const APPLE_SUPPORTS_BY_DEFAULT: Record<string, (device: DeviceInfo) => boolean> = {
  [PUBLIC_COMMANDS.boot]: isNotMacOs,
  [PUBLIC_COMMANDS.install]: isNotMacOs,
  [PUBLIC_COMMANDS.reinstall]: isNotMacOs,
  [PUBLIC_COMMANDS.installFromSource]: isNotMacOs,
  [PUBLIC_COMMANDS.push]: isNotMacOs,
  [PUBLIC_COMMANDS.home]: isNotMacOs,
  [PUBLIC_COMMANDS.appSwitcher]: isNotMacOs,
  [PUBLIC_COMMANDS.clipboard]: (device) =>
    device.platform === 'android' ||
    device.platform === 'linux' ||
    device.platform === 'macos' ||
    device.kind === 'simulator',
  [PUBLIC_COMMANDS.keyboard]: supportsAndroidOrIosNonTv,
  [PUBLIC_COMMANDS.rotate]: supportsAndroidOrIosNonTv,
  [PUBLIC_COMMANDS.alert]: (device) =>
    device.platform === 'android' || isMacOsOrAppleSimulator(device),
  [PUBLIC_COMMANDS.settings]: (device) =>
    device.platform === 'android' || device.platform === 'macos' || device.kind === 'simulator',
  pinch: supportsSynthesisGesture,
  'rotate-gesture': supportsSynthesisGesture,
  'transform-gesture': supportsSynthesisGesture,
};

const APPLE_UNSUPPORTED_HINT_BY_DEFAULT: Record<
  string,
  (device: DeviceInfo) => string | undefined
> = {
  pinch: synthesisGestureUnsupportedHint,
  'rotate-gesture': synthesisGestureUnsupportedHint,
  'transform-gesture': synthesisGestureUnsupportedHint,
};

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
  capability: {
    bucket: 'apple',
    supportsByDefault: APPLE_SUPPORTS_BY_DEFAULT,
    unsupportedHintByDefault: APPLE_UNSUPPORTED_HINT_BY_DEFAULT,
  },
  // Wraps the Apple arm of `resolveLogBackend` verbatim: macOS -> 'macos';
  // an iOS `device` -> 'ios-device'; every other iOS kind -> 'ios-simulator'.
  appLog: {
    resolveBackend: (device: DeviceInfo) =>
      device.platform === 'macos'
        ? 'macos'
        : device.kind === 'device'
          ? 'ios-device'
          : 'ios-simulator',
  },
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
  // Wraps the Android arm of `resolveLogBackend`: every Android device -> 'android'.
  appLog: { resolveBackend: () => 'android' },
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
