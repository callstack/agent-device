import { AppError } from '@agent-device/kernel/errors';
import {
  isMacOs,
  isApplePlatform,
  resolveApplePlatformName,
  resolveDeviceAppleOs,
  type DeviceInfo,
} from '@agent-device/kernel/device';

/**
 * Ceiling on one Apple toolchain identity probe attempt (`xcodebuild -version`, `xcrun
 * --sdk <sdk> --show-sdk-version`). On a fresh macOS host Apple's syspolicyd signature
 * scan blocks the first `xcodebuild`/`xcrun` exec after boot for roughly 18 to 19 seconds
 * at 0% CPU, and the next exec of the same tool is instant; a budget sized for a warm
 * toolchain (the old 10 s / 5 s split) trips on that stall and reports a toolchain
 * timeout that says nothing about the toolchain (#2422).
 *
 * It sits beside the SDK names the probes run against so both Apple toolchain probers
 * read one value without either owning it.
 */
export const COLD_TOOLCHAIN_PROBE_TIMEOUT_MS = 30_000;

export type RunnerApplePlatformName = 'iOS' | 'tvOS' | 'macOS' | 'visionOS';

type RunnerPlatformDeviceKind = 'simulator' | 'device';

type RunnerPlatformProfile = {
  sdkName: Record<RunnerPlatformDeviceKind, string>;
  derivedBaseName: Record<RunnerPlatformDeviceKind, string>;
  xctestrunHints: Record<RunnerPlatformDeviceKind, { preferred: string[]; disallowed: string[] }>;
};

const RUNNER_PLATFORM_PROFILES: Record<RunnerApplePlatformName, RunnerPlatformProfile> = {
  iOS: {
    sdkName: {
      simulator: 'iphonesimulator',
      device: 'iphoneos',
    },
    derivedBaseName: {
      simulator: 'ios-simulator',
      device: 'ios-device',
    },
    xctestrunHints: {
      simulator: {
        preferred: ['iphonesimulator'],
        disallowed: ['iphoneos', 'appletvos', 'appletvsimulator', 'macos'],
      },
      device: {
        preferred: ['iphoneos'],
        disallowed: ['iphonesimulator', 'appletvos', 'appletvsimulator', 'macos'],
      },
    },
  },
  tvOS: {
    sdkName: {
      simulator: 'appletvsimulator',
      device: 'appletvos',
    },
    derivedBaseName: {
      simulator: 'tvos-simulator',
      device: 'tvos-device',
    },
    xctestrunHints: {
      simulator: {
        preferred: ['appletvsimulator'],
        disallowed: ['appletvos', 'iphoneos', 'iphonesimulator', 'macos'],
      },
      device: {
        preferred: ['appletvos'],
        disallowed: ['appletvsimulator', 'iphoneos', 'iphonesimulator', 'macos'],
      },
    },
  },
  macOS: {
    sdkName: {
      simulator: 'macosx',
      device: 'macosx',
    },
    derivedBaseName: {
      simulator: 'macos',
      device: 'macos',
    },
    xctestrunHints: {
      simulator: {
        preferred: ['macos'],
        disallowed: ['iphoneos', 'iphonesimulator', 'appletvos', 'appletvsimulator'],
      },
      device: {
        preferred: ['macos'],
        disallowed: ['iphoneos', 'iphonesimulator', 'appletvos', 'appletvsimulator'],
      },
    },
  },
  visionOS: {
    sdkName: {
      simulator: 'xrsimulator',
      device: 'xros',
    },
    derivedBaseName: {
      simulator: 'visionos-simulator',
      device: 'visionos-device',
    },
    xctestrunHints: {
      simulator: {
        preferred: ['xrsimulator'],
        disallowed: [
          'xros',
          'iphoneos',
          'iphonesimulator',
          'appletvos',
          'appletvsimulator',
          'macos',
        ],
      },
      device: {
        preferred: ['xros'],
        disallowed: [
          'xrsimulator',
          'iphoneos',
          'iphonesimulator',
          'appletvos',
          'appletvsimulator',
          'macos',
        ],
      },
    },
  },
};

const RUNNER_XCUITEST_SCRIPT_PLATFORMS = ['ios', 'macos', 'tvos', 'visionos'] as const;
export type RunnerXcuitestScriptPlatform = (typeof RUNNER_XCUITEST_SCRIPT_PLATFORMS)[number];

const RUNNER_SCRIPT_TARGET: Record<
  RunnerXcuitestScriptPlatform,
  NonNullable<DeviceInfo['target']>
> = {
  ios: 'mobile',
  macos: 'desktop',
  tvos: 'tv',
  visionos: 'mobile',
};

const RUNNER_SCRIPT_APPLE_OS: Record<
  RunnerXcuitestScriptPlatform,
  NonNullable<DeviceInfo['appleOs']>
> = {
  ios: 'ios',
  macos: 'macos',
  tvos: 'tvos',
  visionos: 'visionos',
};

/**
 * The device a build-script invocation stands in for: the script names its platform as a
 * literal and a destination string, and the cache metadata owner speaks `DeviceInfo`.
 * Resolving identity through this one mapping keeps a script-written manifest comparable to
 * the metadata a daemon resolves for the same build.
 */
export function resolveRunnerScriptDevice(
  platform: RunnerXcuitestScriptPlatform,
  destination: string,
): DeviceInfo {
  const kind: DeviceInfo['kind'] =
    platform === 'macos' || !destination.includes('Simulator') ? 'device' : 'simulator';
  return {
    platform: 'apple',
    id: `runner-script-${platform}`,
    name: `Apple runner build script (${platform})`,
    kind,
    target: RUNNER_SCRIPT_TARGET[platform],
    appleOs: RUNNER_SCRIPT_APPLE_OS[platform],
  };
}

export function resolveRunnerPlatformName(device: DeviceInfo): RunnerApplePlatformName {
  if (!isApplePlatform(device.platform)) {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      `Unsupported platform for Apple runner: ${device.platform}`,
    );
  }
  if (isMacOs(device)) {
    return 'macOS';
  }
  // Prefer the stored Apple OS discriminant; fall back to target-based inference
  // for legacy records that predate it. iPadOS maps to the iOS runner profile.
  return resolveApplePlatformName(device.target, device.appleOs);
}

export type RunnerHandoffLane = 'simulator' | 'physical_coredevice';

/** Why a runner is not eligible to be handed to the next daemon. */
export type RunnerHandoffRefusal =
  /** Not an Apple target at all: only Apple runners take leases. */
  | 'non_apple_target'
  /** The macOS desktop target, which is `kind: 'device'` too. */
  | 'macos_host'
  /** A physical tvOS/visionOS runner: never exercised across a daemon restart. */
  | 'physical_non_ios_os'
  /** An XCTest-backed physical iOS device: usbmux-only, and never exercised across a restart. */
  | 'xctest_backend';

export type RunnerHandoffTarget =
  | { handoff: true; lane: RunnerHandoffLane }
  | { handoff: false; reason: RunnerHandoffRefusal };

/**
 * Which runner processes a daemon shutdown may hand to the next daemon (#2681). `kind === 'device'`
 * is not "physical iOS": the macOS desktop host and physical tvOS/visionOS are that same kind, so
 * the lanes are named from the OS discriminant and the physical backend instead.
 *
 * - `simulator`: every Apple-family Simulator, exactly as before #2681. Scoped simulator sets are a
 *   second gate at the handoff itself, not here.
 * - `physical_coredevice`: a physical iOS/iPadOS device whose runner is reached through CoreDevice.
 *
 * macOS keeps its runner under the daemon that built it, and physical tvOS/visionOS plus the
 * usbmux-only `xctest` backend keep the kill-and-rebuild path: #2681 has no handoff evidence for
 * them, and an unexercised handoff is worse than a rebuild.
 */
export function resolveRunnerHandoffTarget(device: DeviceInfo): RunnerHandoffTarget {
  if (!isApplePlatform(device.platform)) {
    return { handoff: false, reason: 'non_apple_target' };
  }
  if (device.kind === 'simulator') {
    return { handoff: true, lane: 'simulator' };
  }
  if (isMacOs(device)) {
    return { handoff: false, reason: 'macos_host' };
  }
  // `resolveDeviceAppleOs` defaults a legacy record to iOS, matching the runner profile
  // `resolveRunnerPlatformName` picks for it.
  const appleOs = resolveDeviceAppleOs(device);
  if (appleOs !== 'ios' && appleOs !== 'ipados') {
    return { handoff: false, reason: 'physical_non_ios_os' };
  }
  if (device.iosPhysicalDeviceBackend === 'xctest') {
    return { handoff: false, reason: 'xctest_backend' };
  }
  return { handoff: true, lane: 'physical_coredevice' };
}

export function resolveRunnerSdkName(
  platformName: RunnerApplePlatformName,
  deviceKind: DeviceInfo['kind'],
): string {
  return RUNNER_PLATFORM_PROFILES[platformName].sdkName[runnerPlatformDeviceKind(deviceKind)];
}

export function resolveRunnerDerivedBaseName(device: DeviceInfo): string {
  const profile = RUNNER_PLATFORM_PROFILES[resolveRunnerPlatformName(device)];
  return profile.derivedBaseName[runnerPlatformDeviceKind(device.kind)];
}

export function resolveRunnerXctestrunHints(device: DeviceInfo): {
  preferred: string[];
  disallowed: string[];
} {
  const profile = RUNNER_PLATFORM_PROFILES[resolveRunnerPlatformName(device)];
  return profile.xctestrunHints[runnerPlatformDeviceKind(device.kind)];
}

export function resolveRunnerDestination(device: DeviceInfo): string {
  const platformName = resolveRunnerPlatformName(device);
  if (platformName === 'macOS') {
    return `platform=macOS,arch=${resolveMacRunnerArch()}`;
  }
  if (device.kind === 'simulator') {
    return `platform=${platformName} Simulator,id=${device.id}`;
  }
  return `platform=${platformName},id=${device.id}`;
}

export function resolveRunnerBuildDestination(device: DeviceInfo): string {
  const platformName = resolveRunnerPlatformName(device);
  if (platformName === 'macOS') {
    return `platform=macOS,arch=${resolveMacRunnerArch()}`;
  }
  if (device.kind === 'simulator') {
    return `platform=${platformName} Simulator,id=${device.id}`;
  }
  return `generic/platform=${platformName}`;
}

export function resolveRunnerBuildDestinationFamily(device: DeviceInfo): string {
  const platformName = resolveRunnerPlatformName(device);
  if (platformName === 'macOS') {
    return `platform=macOS,arch=${resolveMacRunnerArch()}`;
  }
  if (device.kind === 'simulator') {
    return `generic/platform=${platformName} Simulator`;
  }
  return `generic/platform=${platformName}`;
}

function runnerPlatformDeviceKind(deviceKind: DeviceInfo['kind']): RunnerPlatformDeviceKind {
  return deviceKind === 'simulator' ? 'simulator' : 'device';
}

function resolveMacRunnerArch(): 'arm64' | 'x86_64' {
  return process.arch === 'arm64' ? 'arm64' : 'x86_64';
}
