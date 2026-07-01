import { appleOsCapabilities } from './apple-os-capabilities.ts';
import { registerPlatformPlugin, type PlatformPlugin } from './plugin.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { isAudioProbeSupportedDevice } from '../../kernel/audio-probe-support.ts';
import { shouldUseHostMacFastPath, WEB_DESKTOP_DEVICE } from '../platform-inventory.ts';
import type { Platform, DeviceInfo } from '../../kernel/device.ts';
import type { DeviceInventoryRequest } from '../platform-inventory.ts';
import type { RunnerContext } from '../interactor-types.ts';

// ---------------------------------------------------------------------------
// Apple family per-command capability closures. Originally RELOCATED VERBATIM from
// src/core/command-descriptor/registry.ts (perfect-shape §7 step b.2), the
// AppleOS-axis predicates (`target !== 'tv'` / `platform !== 'macos'` /
// `isTvOsDevice`) are now READ from the per-`AppleOS` capability table
// (`apple-os-capabilities.ts`, step d.5) instead of being open-coded. The rewrite is
// behaviorless: the DEVICE-shaped nuance (simulator vs physical device) stays in the
// closure — only the OS-axis facts moved to data — and the non-Apple branches are the
// verbatim verdicts (`appleOsCapabilities` returns `undefined` off the Apple family, so
// each closure is a no-op on android/linux/web). The table-equivalence gate
// (apple-os-capabilities table parity + capability-plugin-routing-parity tests) pins
// every closure byte-for-byte against a verbatim copy of the original predicate across
// the full {command x sample-device} matrix (iOS/iPadOS/tvOS/macOS/visionOS).
// ---------------------------------------------------------------------------

// `install`/`boot`/`reinstall`/`install-from-source`/`push`/`home`/`app-switcher`
// (was `device.platform !== 'macos'`). Off Apple the original was always true.
const supportsAppAndDeviceLifecycle = (device: DeviceInfo): boolean => {
  const caps = appleOsCapabilities(device);
  return caps ? caps.appAndDeviceLifecycle : device.platform !== 'macos';
};

// `keyboard` (was `android || (ios && target !== 'tv')`). Off Apple: `android`.
const supportsKeyboard = (device: DeviceInfo): boolean => {
  const caps = appleOsCapabilities(device);
  return caps ? caps.keyboard : device.platform === 'android';
};

// `rotate` (was `android || (ios && target !== 'tv')`). Off Apple: `android`.
const supportsOrientation = (device: DeviceInfo): boolean => {
  const caps = appleOsCapabilities(device);
  return caps ? caps.orientation : device.platform === 'android';
};

// The Apple arm shared by `clipboard`/`alert`/`settings` (was `macos || simulator`):
// reachable on the macOS host directly, on every other Apple OS only on the simulator.
// Off Apple this preserves the trailing `device.kind === 'simulator'` term verbatim.
const supportsHostOrSimulatorSurface = (device: DeviceInfo): boolean => {
  const caps = appleOsCapabilities(device);
  return caps
    ? caps.physicalDeviceSurfaces || device.kind === 'simulator'
    : device.kind === 'simulator';
};

// `pinch`/`rotate-gesture`/`transform-gesture` (was `android || (ios && simulator &&
// target !== 'tv')`). Apple: the OS multi-touch model AND a simulator (physical iOS
// cannot synthesize). Off Apple: only `android`.
const supportsSynthesisGesture = (device: DeviceInfo): boolean => {
  const caps = appleOsCapabilities(device);
  return caps
    ? caps.multiTouchSynthesis && device.kind === 'simulator'
    : device.platform === 'android';
};

const synthesisGestureUnsupportedHint = (device: DeviceInfo): string | undefined => {
  const caps = appleOsCapabilities(device);
  if (!caps) return undefined; // non-Apple: no multi-touch gate, no hint
  // OS-level block (macOS: no multi-touch; tvOS: no touch) comes from the table.
  if (caps.multiTouchUnsupportedHint) return caps.multiTouchUnsupportedHint;
  // iOS family: multi-touch exists but synthesis is simulator-only — the remaining
  // block is the kind-shaped physical-device case, kept device-shaped here (§7).
  if (device.kind === 'device')
    return 'Two-finger gesture synthesis is iOS-simulator only — not available on physical iOS devices.';
  return undefined;
};

// Per-command support gates the Apple family applies by default, keyed exactly as in
// the command-descriptor registry (a command absent here has no Apple gate).
const APPLE_SUPPORTS_BY_DEFAULT: Record<string, (device: DeviceInfo) => boolean> = {
  [PUBLIC_COMMANDS.boot]: supportsAppAndDeviceLifecycle,
  [PUBLIC_COMMANDS.install]: supportsAppAndDeviceLifecycle,
  [PUBLIC_COMMANDS.reinstall]: supportsAppAndDeviceLifecycle,
  [PUBLIC_COMMANDS.installFromSource]: supportsAppAndDeviceLifecycle,
  [PUBLIC_COMMANDS.push]: supportsAppAndDeviceLifecycle,
  [PUBLIC_COMMANDS.home]: supportsAppAndDeviceLifecycle,
  [PUBLIC_COMMANDS.appSwitcher]: supportsAppAndDeviceLifecycle,
  [PUBLIC_COMMANDS.clipboard]: (device) =>
    device.platform === 'android' ||
    device.platform === 'linux' ||
    supportsHostOrSimulatorSurface(device),
  [PUBLIC_COMMANDS.keyboard]: supportsKeyboard,
  [PUBLIC_COMMANDS.rotate]: supportsOrientation,
  [PUBLIC_COMMANDS.alert]: (device) =>
    device.platform === 'android' || supportsHostOrSimulatorSurface(device),
  [PUBLIC_COMMANDS.settings]: (device) =>
    device.platform === 'android' || supportsHostOrSimulatorSurface(device),
  [PUBLIC_COMMANDS.audio]: isAudioProbeSupportedDevice,
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
  // Wraps the Apple arm of `supportsPlatformPerfMetrics`: every Apple device
  // (ios/macos, any kind/target) reports perf-metrics support.
  perf: { supportsMetrics: () => true },
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
  capability: {
    bucket: 'android',
    supportsByDefault: { [PUBLIC_COMMANDS.audio]: isAudioProbeSupportedDevice },
  },
  // Wraps the Android arm of `resolveLogBackend`: every Android device -> 'android'.
  appLog: { resolveBackend: () => 'android' },
  // Wraps the Android arm of `supportsPlatformPerfMetrics`: every Android device
  // reports perf-metrics support.
  perf: { supportsMetrics: () => true },
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
