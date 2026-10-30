import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  isMacOs,
  isApplePlatform,
  resolveApplePlatformName,
  resolveDeviceAppleOs,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { readHostCpuArchSync } from './host.ts';
import type { AppleSdkName } from './runner-toolchain-identity.ts';

/**
 * The snapshot bridge's shared full-screen rule, named once. The bridge's runtime includes it and
 * the runner's UITests target compiles against it through HEADER_SEARCH_PATHS, so its bytes change
 * both compiled binaries. It sits with the constants this package shares: the bridge cache identity
 * and the runner fingerprint both read it without either subtree entering the other's graph.
 */
export const SHARED_FOREGROUND_GEOMETRY_HEADER_FILENAME = 'ForegroundApplicationGeometry.h';

export type RunnerApplePlatformName = 'iOS' | 'tvOS' | 'macOS' | 'visionOS';

type RunnerPlatformDeviceKind = 'simulator' | 'device';

type RunnerPlatformProfile = {
  sdkName: Record<RunnerPlatformDeviceKind, AppleSdkName>;
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

/**
 * The derived-data directory an operator pinned with `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH`, or
 * `undefined` when the managed cache layout applies. One path serves every Apple platform, so the
 * runner, its cache retention, and the clean script all read the override here.
 */
export function resolveRunnerDerivedOverride(env: NodeJS.ProcessEnv): string | undefined {
  const override = env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH?.trim();
  return override ? path.resolve(override) : undefined;
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
): AppleSdkName {
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
  return readHostCpuArchSync() === 'arm64' ? 'arm64' : 'x86_64';
}
