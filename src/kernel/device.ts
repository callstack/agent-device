import { AppError } from './errors.ts';

export type ApplePlatform = 'ios' | 'macos';
// Explicit, stored Apple operating system. All six literals are reserved so the
// type is stable as platform support grows, but discovery only ever populates
// the four currently supported ones ('ios' | 'ipados' | 'tvos' | 'macos').
export type AppleOS = 'ios' | 'ipados' | 'tvos' | 'watchos' | 'visionos' | 'macos';
export const PLATFORMS = ['ios', 'macos', 'android', 'linux', 'web'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_SELECTORS = [...PLATFORMS, 'apple'] as const;
export type PlatformSelector = (typeof PLATFORM_SELECTORS)[number];
const DEVICE_KINDS = ['simulator', 'emulator', 'device'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DEVICE_TARGETS = ['mobile', 'tv', 'desktop'] as const;
export type DeviceTarget = (typeof DEVICE_TARGETS)[number];

export type DeviceInfo = {
  platform: Platform;
  id: string;
  name: string;
  kind: DeviceKind;
  target?: DeviceTarget;
  // Explicit Apple OS discriminant populated at discovery for Apple devices.
  // Optional so legacy records (and non-Apple platforms) remain valid.
  appleOs?: AppleOS;
  booted?: boolean;
  simulatorSetPath?: string;
};

type DeviceSelector = {
  platform?: PlatformSelector;
  target?: DeviceTarget;
  deviceName?: string;
  udid?: string;
  serial?: string;
};

type DeviceSelectionContext = {
  simulatorSetPath?: string;
};

export function isApplePlatform(
  platform: Platform | PlatformSelector | undefined,
): platform is ApplePlatform | 'apple' {
  return platform === 'apple' || platform === 'ios' || platform === 'macos';
}

export function isMobilePlatform(platform: Platform): boolean {
  // Leaf-platform family predicate: the two phone/tablet device platforms.
  return platform === 'ios' || platform === 'android';
}

/**
 * The tvOS Apple-OS leaf predicate. tvOS is modeled as the `ios` platform with a
 * `tv` form-factor target (ADR-0009 defers the `Platform` collapse; discovery also
 * stores `appleOs: 'tvos'`). Naming the leaf keeps its focus-only interaction
 * contract — XCUIRemote focus navigation, and NO coordinate tap/gesture — gated by
 * one explicit predicate instead of a `target === 'tv'` string compare smeared
 * across the Apple interaction paths.
 *
 * Apple-only by design: Android TV also uses `target: 'tv'` but is a DISTINCT leaf,
 * so the `platform === 'ios'` gate is load-bearing (do not widen it to any TV target).
 */
export function isTvOsDevice(device: Pick<DeviceInfo, 'platform' | 'target'>): boolean {
  return device.platform === 'ios' && device.target === 'tv';
}

export function isPlatform(value: unknown): value is Platform {
  // Leaf-platform membership derived from the canonical PLATFORMS tuple (excludes the
  // `apple` selector, which is not a concrete device platform).
  return (PLATFORMS as readonly unknown[]).includes(value);
}

export function matchesPlatformSelector(
  platform: Platform,
  selector: PlatformSelector | undefined,
): boolean {
  if (!selector) return true;
  if (selector === 'apple') return isApplePlatform(platform);
  return platform === selector;
}

export function resolveApplePlatformName(
  platformOrTarget: ApplePlatform | DeviceTarget | undefined,
  appleOs?: AppleOS,
): 'iOS' | 'tvOS' | 'macOS' | 'visionOS' {
  // Prefer the explicit, stored Apple OS when present; legacy records without
  // it keep resolving through the existing target-based inference below.
  if (appleOs) return resolveRunnerPlatformNameForAppleOs(appleOs);
  if (platformOrTarget === 'macos' || platformOrTarget === 'desktop') return 'macOS';
  if (platformOrTarget === 'tv') return 'tvOS';
  return 'iOS';
}

function resolveRunnerPlatformNameForAppleOs(
  appleOs: AppleOS,
): 'iOS' | 'tvOS' | 'macOS' | 'visionOS' {
  switch (appleOs) {
    case 'tvos':
      return 'tvOS';
    case 'macos':
      return 'macOS';
    case 'visionos':
      return 'visionOS';
    // iOS and iPadOS share the single iOS runner profile/SDK. watchOS remains
    // reserved in the type but is never produced by discovery; defaulting it to
    // iOS keeps any future record on a valid runner profile without introducing
    // watchOS support.
    default:
      return 'iOS';
  }
}

export function resolveAppleSimulatorSetPathForSelector(params: {
  simulatorSetPath?: string;
  platform?: PlatformSelector;
  target?: DeviceTarget;
}): string | undefined {
  const { simulatorSetPath, platform, target } = params;
  if (!simulatorSetPath) return undefined;
  if (platform === 'macos' || target === 'desktop') {
    return undefined;
  }
  return simulatorSetPath;
}

function supportsAppleSimulatorSelection(platform: PlatformSelector | undefined): boolean {
  return !platform || platform === 'apple' || platform === 'ios';
}

export async function resolveDevice(
  devices: DeviceInfo[],
  selector: DeviceSelector,
  context: DeviceSelectionContext = {},
): Promise<DeviceInfo> {
  let candidates = devices;
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  if (selector.platform) {
    candidates = candidates.filter((d) => matchesPlatformSelector(d.platform, selector.platform));
  }
  if (selector.target) {
    candidates = candidates.filter((d) => (d.target ?? 'mobile') === selector.target);
  }

  if (selector.udid) {
    const match = candidates.find((d) => d.id === selector.udid && isApplePlatform(d.platform));
    if (!match) {
      throw new AppError('DEVICE_NOT_FOUND', `No Apple device with UDID ${selector.udid}`);
    }
    return match;
  }

  if (selector.serial) {
    const match = candidates.find((d) => d.id === selector.serial && d.platform === 'android');
    if (!match)
      throw new AppError('DEVICE_NOT_FOUND', `No Android device with serial ${selector.serial}`);
    return match;
  }

  if (selector.deviceName) {
    const target = normalize(selector.deviceName);
    const match = candidates.find((d) => normalize(d.name) === target);
    if (!match) {
      throw new AppError('DEVICE_NOT_FOUND', `No device named ${selector.deviceName}`);
    }
    return match;
  }

  const onlyCandidate = candidates[0];
  if (onlyCandidate !== undefined && candidates.length === 1) return onlyCandidate;

  if (candidates.length === 0) {
    const simulatorSetPath = context.simulatorSetPath;
    if (simulatorSetPath && supportsAppleSimulatorSelection(selector.platform)) {
      throw new AppError('DEVICE_NOT_FOUND', 'No devices found in the scoped simulator set', {
        simulatorSetPath,
        hint: `The simulator set at "${simulatorSetPath}" appears to be empty. Create a simulator first:\n  xcrun simctl --set "${simulatorSetPath}" create "iPhone 16" com.apple.CoreSimulator.SimDeviceType.iPhone-16 com.apple.CoreSimulator.SimRuntime.iOS-18-0`,
        selector,
      });
    }
    throw new AppError('DEVICE_NOT_FOUND', 'No devices found', { selector });
  }

  // Prefer virtual devices (simulators/emulators) over physical devices unless
  // a physical device was explicitly requested via --device/--udid/--serial.
  const virtual = candidates.filter((d) => d.kind !== 'device');
  if (virtual.length > 0) {
    candidates = virtual;
  }

  const booted = candidates.filter((d) => d.booted);
  const onlyBooted = booted[0];
  if (onlyBooted !== undefined && booted.length === 1) return onlyBooted;

  // When multiple candidates remain equally valid, preserve discovery order from
  // the underlying platform tools rather than introducing another tie-breaker here.
  const selected = booted[0] ?? candidates[0];
  if (selected === undefined) {
    throw new AppError('DEVICE_NOT_FOUND', 'No devices found', { selector });
  }
  return selected;
}
