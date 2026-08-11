import { appleOsCapabilities } from './capabilities.ts';
import type { PlatformPlugin } from '@agent-device/contracts/platform';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { isAudioProbeSupportedDevice } from '@agent-device/contracts/platform';
import { isTvOsDevice, resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';
import type { RunnerContext } from '@agent-device/contracts/interaction';

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

// `install`/`reinstall`/`install-from-source`/`push`/`home`/`app-switcher`
// (was `!isMacOs(device)`). Off Apple (caps undefined) the original was
// always true — no non-Apple platform is macOS.
const supportsAppAndDeviceLifecycle = (device: DeviceInfo): boolean => {
  const caps = appleOsCapabilities(device);
  return caps ? caps.appAndDeviceLifecycle : true;
};

const supportsCoreDevicePhysicalOperation = (device: DeviceInfo): boolean =>
  device.platform !== 'apple' ||
  device.kind !== 'device' ||
  device.iosPhysicalDeviceBackend !== 'xctest';

const supportsAppInstallation = (device: DeviceInfo): boolean =>
  supportsAppAndDeviceLifecycle(device) && supportsCoreDevicePhysicalOperation(device);

// `keyboard` (was `android || (ios && target !== 'tv')`). Off Apple: `android`.
const supportsKeyboard = (device: DeviceInfo): boolean => {
  const caps = appleOsCapabilities(device);
  return caps ? caps.keyboard : device.platform === 'android';
};

// `orientation` (was `android || (ios && target !== 'tv')`). Off Apple: `android`.
const supportsOrientation = (device: DeviceInfo): boolean => {
  const caps = appleOsCapabilities(device);
  return caps ? caps.orientation : device.platform === 'android';
};

// The Apple arm shared by `clipboard`/`settings` (was `macos || simulator`):
// reachable on the macOS host directly, on every other Apple OS only on the simulator.
// Off Apple this preserves the trailing `device.kind === 'simulator'` term verbatim.
const supportsHostOrSimulatorSurface = (device: DeviceInfo): boolean => {
  const caps = appleOsCapabilities(device);
  return caps
    ? caps.physicalDeviceSurfaces || device.kind === 'simulator'
    : device.kind === 'simulator';
};

// Alerts use the host/simulator surface plus physical iOS, whose XCTest path is
// device-verified. iPadOS/visionOS remain closed until independently verified.
const supportsAlertSurface = (device: DeviceInfo): boolean =>
  device.platform === 'android' ||
  (device.platform === 'apple' && resolveDeviceAppleOs(device) === 'ios') ||
  supportsHostOrSimulatorSurface(device);
// `tv-remote` is Android-TV or tvOS only. Off Apple this preserves the Android-TV
// branch so the relocated Apple closure stays equivalent to the full original
// supports predicate under the parity guard; the closure is only consulted for Apple
// devices in production capability routing.
const supportsTvRemote = (device: DeviceInfo): boolean => {
  if (device.platform === 'android') return device.target === 'tv';
  return isTvOsDevice(device);
};

// Per-command support gates the Apple family applies by default, keyed exactly as in
// the command-descriptor registry (a command absent here has no Apple gate).
const APPLE_SUPPORTS_BY_DEFAULT: Record<string, (device: DeviceInfo) => boolean> = {
  [PUBLIC_COMMANDS.install]: supportsAppInstallation,
  [PUBLIC_COMMANDS.reinstall]: supportsAppInstallation,
  [PUBLIC_COMMANDS.installFromSource]: supportsAppInstallation,
  [PUBLIC_COMMANDS.perf]: supportsCoreDevicePhysicalOperation,
  [PUBLIC_COMMANDS.push]: supportsAppAndDeviceLifecycle,
  [PUBLIC_COMMANDS.home]: supportsAppAndDeviceLifecycle,
  [PUBLIC_COMMANDS.appSwitcher]: supportsAppAndDeviceLifecycle,
  [PUBLIC_COMMANDS.clipboard]: (device) =>
    device.platform === 'android' ||
    device.platform === 'linux' ||
    supportsHostOrSimulatorSurface(device),
  [PUBLIC_COMMANDS.keyboard]: supportsKeyboard,
  [PUBLIC_COMMANDS.orientation]: supportsOrientation,
  [PUBLIC_COMMANDS.tvRemote]: supportsTvRemote,
  [PUBLIC_COMMANDS.alert]: supportsAlertSurface,
  [PUBLIC_COMMANDS.settings]: (device) =>
    device.platform === 'android' || supportsHostOrSimulatorSurface(device),
  [PUBLIC_COMMANDS.audio]: isAudioProbeSupportedDevice,
};

const APPLE_UNSUPPORTED_HINT_BY_DEFAULT: Record<
  string,
  (device: DeviceInfo) => string | undefined
> = {
  [PUBLIC_COMMANDS.install]: coreDeviceOnlyPhysicalOperationHint,
  [PUBLIC_COMMANDS.reinstall]: coreDeviceOnlyPhysicalOperationHint,
  [PUBLIC_COMMANDS.installFromSource]: coreDeviceOnlyPhysicalOperationHint,
  [PUBLIC_COMMANDS.perf]: coreDeviceOnlyPhysicalOperationHint,
  [PUBLIC_COMMANDS.viewport]: (device) =>
    device.platform === 'apple'
      ? 'viewport resizes web targets only (--platform web). Apple screen geometry is fixed by the selected simulator or device type — open a different simulator to test another screen size.'
      : undefined,
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
};

function coreDeviceOnlyPhysicalOperationHint(device: DeviceInfo): string | undefined {
  if (supportsCoreDevicePhysicalOperation(device)) return undefined;
  return 'This command requires a CoreDevice-backed physical iOS device. The selected XCTest backend supports open, close, interactions, snapshots, and screenshots.';
}

// The Apple plugin wraps today's existing interactor factory lazily.
// `as const satisfies PlatformPlugin` preserves
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
  // Apple exposes explicit frame-health and memory observations.
  perf: { supportsObservations: () => true },
  // Declares the platform-gated request provider resolvers the Apple family owns: the
  // runner + tool providers (formerly gated by `isApplePlatform(device.platform)`).
  providers: { platformGatedResolvers: ['appleRunnerProvider', 'appleToolProvider'] },
  createInteractor: async (device: DeviceInfo, runner: RunnerContext) => {
    const { createAppleInteractor } = await import('./interactor.ts');
    return createAppleInteractor(device, runner);
  },
} as const satisfies PlatformPlugin;
