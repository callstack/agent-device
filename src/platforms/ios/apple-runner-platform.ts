import { AppError } from '../../utils/errors.ts';
import { isApplePlatform, resolveApplePlatformName, type DeviceInfo } from '../../utils/device.ts';

export type RunnerApplePlatformName = 'iOS' | 'tvOS' | 'macOS';

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
};

export function resolveRunnerPlatformName(device: DeviceInfo): RunnerApplePlatformName {
  if (!isApplePlatform(device.platform)) {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      `Unsupported platform for Apple runner: ${device.platform}`,
    );
  }
  if (device.platform === 'macos') {
    return 'macOS';
  }
  // Prefer the stored Apple OS discriminant; fall back to target-based inference
  // for legacy records that predate it. iPadOS maps to the iOS runner profile.
  return resolveApplePlatformName(device.target, device.appleOs);
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
