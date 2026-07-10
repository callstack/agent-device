import { appleOsCapabilities } from '../../core/platform-plugin/apple-os-capabilities.ts';
import type { PlatformPlugin } from '../../core/platform-plugin/plugin.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { isAudioProbeSupportedDevice } from '../../kernel/audio-probe-support.ts';
import { shouldUseHostMacFastPath } from '../../core/platform-inventory.ts';
import { isMacOs, isTvOsDevice, type DeviceInfo } from '../../kernel/device.ts';
import type { DeviceInventoryRequest } from '../../core/platform-inventory.ts';
import type { RunnerContext } from '../../core/interactor-types.ts';

// ---------------------------------------------------------------------------
// Apple family per-command capability closures. Originally RELOCATED VERBATIM from
// src/core/command-descriptor/registry.ts (ADR-0009), the
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
// (was `!isMacOs(device)`). Off Apple (caps undefined) the original was
// always true — no non-Apple platform is macOS.
const supportsAppAndDeviceLifecycle = (device: DeviceInfo): boolean => {
  const caps = appleOsCapabilities(device);
  return caps ? caps.appAndDeviceLifecycle : true;
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

// `tv-remote` is Android-TV or tvOS only. Off Apple this preserves the Android-TV
// branch so the relocated Apple closure stays equivalent to the full original
// supports predicate under the parity guard; the closure is only consulted for Apple
// devices in production capability routing.
const supportsTvRemote = (device: DeviceInfo): boolean => {
  if (device.platform === 'android') return device.target === 'tv';
  return isTvOsDevice(device);
};

const synthesisGestureUnsupportedHint = (device: DeviceInfo): string | undefined => {
  const caps = appleOsCapabilities(device);
  if (!caps) return undefined; // non-Apple: no multi-touch gate, no hint
  // OS-level block (macOS: no multi-touch; tvOS: no touch) comes from the table.
  if (caps.multiTouchUnsupportedHint) return caps.multiTouchUnsupportedHint;
  // iOS family: multi-touch exists but synthesis is simulator-only — the remaining
  // block is the kind-shaped physical-device case, kept device-shaped in the leaf
  // rather than flattened into the table (do-not-flatten; see docs/adr/0009).
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
  [PUBLIC_COMMANDS.tvRemote]: supportsTvRemote,
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
  [PUBLIC_COMMANDS.tvRemote]: (device) =>
    device.platform === 'android'
      ? device.target === 'tv'
        ? undefined
        : 'tv-remote is supported only on Android TV targets.'
      : !appleOsCapabilities(device)
        ? undefined
        : isTvOsDevice(device)
          ? undefined
          : 'tv-remote is supported only on tvOS devices.',
  pinch: synthesisGestureUnsupportedHint,
  'rotate-gesture': synthesisGestureUnsupportedHint,
  'transform-gesture': synthesisGestureUnsupportedHint,
};

// The Apple plugin WRAPS today's existing factories (its `createInteractor` in
// `./interactor.ts`) and the inventory if-chain (src/core/platform-inventory.ts) as
// LAZY methods. No leaf code is rewritten: the dynamic `import()`s and the per-platform
// list calls are byte-for-byte the same as the hand-authored `getInteractor` switch arm
// and `listLocalDeviceInventory` branch. `as const satisfies PlatformPlugin` preserves
// the plugin's literal `platforms` tuple so the registry totality assertion (in
// `core/interactors/register-builtins.ts`) is a real compile-time check.

export const applePlugin = {
  id: 'apple',
  // Apple owns the single collapsed `apple` platform; the `appleOs` field
  // discriminates the OS (ADR-0009 / issue #979).
  platforms: ['apple'],
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
      isMacOs(device) ? 'macos' : device.kind === 'device' ? 'ios-device' : 'ios-simulator',
  },
  // Wraps the Apple arm of `supportsPlatformPerfMetrics`: every Apple device
  // (ios/macos, any kind/target) reports perf-metrics support. `metricsSamplerTag`
  // wraps the else-arm of the former `buildPerfResponseData` sampling branch: every
  // supported Apple device routes to the Apple `perf metrics` sampler.
  perf: { supportsMetrics: () => true, metricsSamplerTag: () => 'apple' },
  // Wraps the Apple arm of `resolveRecordingBackendForDevice` verbatim: macOS ->
  // 'macos'; an iOS `device` -> 'ios-device'; every other iOS kind (simulator, incl.
  // tvOS/iPadOS/visionOS) -> 'ios-simulator'. Mirrors the appLog resolveBackend shape.
  recording: {
    resolveBackendTag: (device: DeviceInfo) =>
      isMacOs(device) ? 'macos' : device.kind === 'device' ? 'ios-device' : 'ios-simulator',
  },
  // Declares the platform-gated request provider resolvers the Apple family owns: the
  // runner + tool providers (formerly gated by `isApplePlatform(device.platform)`).
  providers: { platformGatedResolvers: ['appleRunnerProvider', 'appleToolProvider'] },
  createInteractor: async (device: DeviceInfo, runner: RunnerContext) => {
    const { createAppleInteractor } = await import('./interactor.ts');
    return createAppleInteractor(device, runner);
  },
  // Reproduces the macOS host fast-path + Apple-simulator branch of the
  // inventory if-chain, reusing the SAME predicate (no divergent copy).
  discoverDevices: async (request: DeviceInventoryRequest) => {
    if (shouldUseHostMacFastPath(request)) {
      const { listMacosDevices } = await import('./os/macos/devices.ts');
      return await listMacosDevices();
    }
    const { listAppleDevices } = await import('./core/devices.ts');
    return await listAppleDevices({
      simulatorSetPath: request.iosSimulatorSetPath,
      udid: request.udid,
    });
  },
} as const satisfies PlatformPlugin;
