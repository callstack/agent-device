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

export type DeviceSelector = {
  platform?: PlatformSelector;
  target?: DeviceTarget;
  deviceName?: string;
  udid?: string;
  serial?: string;
};

type DeviceSelectionContext = {
  simulatorSetPath?: string;
  allowStoppedAndroidAvdPlaceholders?: boolean;
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

export function sortAppleDevicesForSelection<TDevice extends DeviceInfo>(
  devices: TDevice[],
): TDevice[] {
  return devices
    .map((device, index) => ({ device, index }))
    .sort((left, right) => compareAppleDevicesForSelection(left, right))
    .map(({ device }) => device);
}

function supportsAppleSimulatorSelection(platform: PlatformSelector | undefined): boolean {
  return !platform || platform === 'apple' || platform === 'ios';
}

export async function resolveDevice(
  devices: DeviceInfo[],
  selector: DeviceSelector,
  context: DeviceSelectionContext = {},
): Promise<DeviceInfo> {
  let candidates = devices.filter((device) => matchesDeviceSelector(device, selector));

  if (selector.udid) {
    const match = candidates.find(
      (device) => device.id === selector.udid && isApplePlatform(device.platform),
    );
    if (!match)
      throw new AppError('DEVICE_NOT_FOUND', `No Apple device with UDID ${selector.udid}`);
    return match;
  }

  if (selector.serial) {
    const match = candidates.find(
      (device) => device.id === selector.serial && device.platform === 'android',
    );
    if (!match)
      throw new AppError('DEVICE_NOT_FOUND', `No Android device with serial ${selector.serial}`);
    return match;
  }

  if (context.allowStoppedAndroidAvdPlaceholders !== true) {
    candidates = candidates.filter((device) => !isStoppedAndroidAvdPlaceholder(device));
  }

  if (selector.deviceName) {
    const normalizedName = normalizeDeviceName(selector.deviceName);
    const match = candidates.find((device) => normalizeDeviceName(device.name) === normalizedName);
    if (!match) throw new AppError('DEVICE_NOT_FOUND', `No device named ${selector.deviceName}`);
    return match;
  }

  if (isAppleDeviceCandidateSet(candidates)) {
    candidates = sortAppleDevicesForSelection(candidates);
  }

  const onlyCandidate = candidates[0];
  if (onlyCandidate !== undefined && candidates.length === 1) return onlyCandidate;

  if (candidates.length === 0) {
    throwNoDevicesFound(selector, context);
  }

  const virtual = candidates.filter((device) => device.kind !== 'device');
  const selectable = virtual.length > 0 ? virtual : candidates;
  const booted = selectable.filter((device) => device.booted);
  const onlyBooted = booted[0];
  if (onlyBooted && booted.length === 1 && !isAppleDeviceCandidateSet(selectable)) {
    return onlyBooted;
  }
  const selected = isAppleDeviceCandidateSet(selectable)
    ? selectable[0]
    : (booted[0] ?? selectable[0]);
  if (!selected) throwNoDevicesFound(selector, context);
  return selected;
}

function isStoppedAndroidAvdPlaceholder(device: DeviceInfo): boolean {
  return (
    device.platform === 'android' &&
    device.kind === 'emulator' &&
    device.booted === false &&
    !/^emulator-\d+$/.test(device.id)
  );
}

export function matchesDeviceSelector(
  device: DeviceInfo,
  selector: DeviceSelector,
  options: { includeExplicitSelectors?: boolean } = {},
): boolean {
  return (
    matchesPlatformSelector(device.platform, selector.platform) &&
    (!selector.target || (device.target ?? 'mobile') === selector.target) &&
    (!options.includeExplicitSelectors || matchesExplicitDeviceSelector(device, selector))
  );
}

function matchesExplicitDeviceSelector(device: DeviceInfo, selector: DeviceSelector): boolean {
  if (selector.udid && !(device.id === selector.udid && isApplePlatform(device.platform))) {
    return false;
  }
  if (selector.serial && !(device.id === selector.serial && device.platform === 'android')) {
    return false;
  }
  if (
    selector.deviceName &&
    normalizeDeviceName(device.name) !== normalizeDeviceName(selector.deviceName)
  ) {
    return false;
  }
  return true;
}

function throwNoDevicesFound(selector: DeviceSelector, context: DeviceSelectionContext): never {
  const simulatorSetPath = context.simulatorSetPath;
  if (simulatorSetPath && supportsAppleSimulatorSelection(selector.platform)) {
    throw new AppError('DEVICE_NOT_FOUND', 'No devices found in the scoped simulator set', {
      simulatorSetPath,
      hint: `The simulator set at "${simulatorSetPath}" appears to be empty. Create a compatible simulator first with xcrun simctl --set "${simulatorSetPath}" create, or remove the scoped simulator set.`,
      selector,
    });
  }
  throw new AppError('DEVICE_NOT_FOUND', 'No devices found', { selector });
}

function normalizeDeviceName(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function compareAppleDevicesForSelection<TDevice extends DeviceInfo>(
  left: { device: TDevice; index: number },
  right: { device: TDevice; index: number },
): number {
  return (
    appleDeviceSelectionRank(left.device) - appleDeviceSelectionRank(right.device) ||
    Number(right.device.booted === true) - Number(left.device.booted === true) ||
    left.device.name.localeCompare(right.device.name) ||
    left.index - right.index
  );
}

function appleDeviceSelectionRank(device: DeviceInfo): number {
  if (device.kind === 'simulator') return appleTargetSelectionRank(device, 0, 1, 2, 3);
  if (device.kind === 'device' && device.platform === 'ios')
    return appleTargetSelectionRank(device, 10, 11, 12, 13);
  return 14;
}

function appleTargetSelectionRank(
  device: DeviceInfo,
  phoneRank: number,
  ipadRank: number,
  tvRank: number,
  fallbackRank: number,
): number {
  const targetRanks: Record<DeviceTarget, number> = {
    mobile: isIpadDeviceName(device.name) ? ipadRank : phoneRank,
    tv: tvRank,
    desktop: fallbackRank,
  };
  return targetRanks[device.target ?? 'mobile'];
}

function isAppleDeviceCandidateSet(devices: DeviceInfo[]): boolean {
  return devices.length > 0 && devices.every((device) => isApplePlatform(device.platform));
}

function isIpadDeviceName(name: string): boolean {
  return /\bipad\b/i.test(name);
}
