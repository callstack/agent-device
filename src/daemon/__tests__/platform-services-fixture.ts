import { vi } from 'vitest';
import {
  IOS_SAFARI_BUNDLE_ID,
  isDeepLinkTarget,
  isWebUrl,
  resolveIosDeviceDeepLinkBundleId,
} from '@agent-device/contracts/command';
import { parseSessionSurface, type SessionSurface } from '@agent-device/contracts/session';
import {
  isApplePlatform,
  isIosFamily,
  isMacOs,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  classifyAndroidAppTarget,
  formatAndroidInstalledPackageRequiredMessage,
} from '@agent-device/platform-android/mechanics';
import type { ClaimRecoveryGatewayFactory } from '../device/claim-recovery-gateway.ts';
import type { DaemonPlatformServices } from '../platform-services.ts';
import { unavailableDeviceRuntimeGateway } from './support/unavailable-device-runtime-gateway.ts';

/** The `DaemonPlatformServices` port: daemon suites assert when each ask happens; every host leaf behind a member resolves through the platform packages, so suite mocks on the package leaves answer the member. A suite overrides the single member it cares about, as production wiring replaces one composed capability. Members are module-level stable references so two fixture instances deep-compare equal. */
export function daemonPlatformServicesFixture(
  overrides: Partial<DaemonPlatformServices> = {},
): DaemonPlatformServices {
  return Object.freeze({
    appleSessionObservation: fixtureAppleSessionObservation,
    deviceBootObservation: fixtureDeviceBootObservation,
    ensureLocalDeviceReady: fixtureEnsureLocalDeviceReady,
    resolveRequestedOpenSurface: fixtureResolveRequestedOpenSurface,
    validateOpenRelaunchTarget: fixtureValidateOpenRelaunchTarget,
    resolveSessionAppBundleIdForTarget: fixtureResolveSessionAppBundleIdForTarget,
    ...overrides,
  });
}

const fixtureAppleSessionObservation = Object.freeze({
  observeRunnerSession: async () => undefined,
  resolveSoleForegroundApp: async () => undefined,
});

const fixtureDeviceBootObservation = Object.freeze({
  observeBootTimeMs: async (device: DeviceInfo) => {
    if (isIosFamily(device) && device.kind === 'simulator') {
      const { observeSimulatorBootTimeMs } =
        await import('@agent-device/platform-apple/simulator-boot');
      return await observeSimulatorBootTimeMs(device);
    }
    if (device.platform === 'android') {
      const { observeAndroidBootTimeMs } =
        await import('@agent-device/platform-android/device-boot');
      return await observeAndroidBootTimeMs(device);
    }
    return { observed: false, reason: 'unsupported-device' } as const;
  },
});

async function fixtureEnsureLocalDeviceReady(device: DeviceInfo): Promise<boolean> {
  if (isIosFamily(device)) {
    if (device.kind === 'simulator') {
      const { ensureBootedSimulator } = await import('@agent-device/platform-apple/simulator');
      await ensureBootedSimulator(device);
      return true;
    }
    if (device.kind === 'device') {
      const { resolveIosPhysicalDeviceControl } =
        await import('@agent-device/platform-apple/physical-device');
      const control = resolveIosPhysicalDeviceControl(device);
      await control.ensureReady(device);
      return true;
    }
  }
  if (device.platform === 'android') {
    const { waitForAndroidBoot } = await import('@agent-device/platform-android/mechanics');
    await waitForAndroidBoot(device.id);
    return true;
  }
  return false;
}

function fixtureResolveRequestedOpenSurface(params: {
  device: DeviceInfo;
  surfaceFlag: string | undefined;
  openTarget: string | undefined;
  existingSurface?: SessionSurface;
}): SessionSurface {
  const { device, surfaceFlag, openTarget, existingSurface } = params;
  if (device.platform === 'linux') {
    return resolveSurfaceFor('linux', surfaceFlag, openTarget, existingSurface);
  }
  if (isMacOs(device)) {
    return resolveSurfaceFor('macos', surfaceFlag, openTarget, existingSurface);
  }
  if (surfaceFlag) {
    throw new AppError('INVALID_ARGS', 'surface is only supported on macOS and Linux');
  }
  return 'app';
}

async function fixtureValidateOpenRelaunchTarget(params: {
  target: string | undefined;
  platform: string | undefined;
  surface?: SessionSurface;
}): Promise<string | undefined> {
  const { target, platform, surface } = params;
  if (target && isDeepLinkTarget(target)) {
    return 'open --relaunch does not support URL targets.';
  }
  if (surface !== undefined && surface !== 'app') {
    return 'open --relaunch is supported only for app surfaces.';
  }
  if (platform === 'android' && target) {
    if (classifyAndroidAppTarget(target) === 'binary') {
      return formatAndroidInstalledPackageRequiredMessage(target);
    }
  }
  return undefined;
}

/**
 * The open-target bundle-id rules as the fixture answers them: contract Safari/deep-link rules and
 * the platform packages' own resolvers, no root open-target module. Both the services port and the
 * canned lifecycle `resolveOpenTarget` answer through this single implementation.
 */
export async function fixtureResolveSessionAppBundleIdForTarget(
  device: DeviceInfo,
  openTarget: string | undefined,
  currentAppBundleId: string | undefined,
): Promise<string | undefined> {
  if (device.platform === 'harmonyos') {
    return bundleIdFromOpenTarget(openTarget) ?? currentAppBundleId;
  }
  return (
    (await resolveIosBundleIdForOpen(device, openTarget, currentAppBundleId)) ??
    (await resolveAndroidPackage(device, openTarget)) ??
    (device.platform === 'android' && openTarget && isDeepLinkTarget(openTarget)
      ? currentAppBundleId
      : undefined)
  );
}

const LINUX_SURFACES: ReadonlySet<SessionSurface> = new Set(['app', 'desktop', 'frontmost-app']);

function resolveSurfaceFor(
  os: 'linux' | 'macos',
  surfaceFlag: string | undefined,
  openTarget: string | undefined,
  existingSurface: SessionSurface | undefined,
): SessionSurface {
  if (!surfaceFlag) return existingSurface ?? 'app';
  const surface = parseSessionSurface(surfaceFlag);
  if (os === 'linux' && !LINUX_SURFACES.has(surface)) {
    throw new AppError(
      'INVALID_ARGS',
      `Linux supports --surface app, desktop, and frontmost-app (got "${surfaceFlag}")`,
    );
  }
  if (surface !== 'app' && surface !== 'menubar' && openTarget) {
    throw new AppError('INVALID_ARGS', `open --surface ${surface} does not accept an app target`);
  }
  return surface;
}

async function resolveIosBundleIdForOpen(
  device: DeviceInfo,
  openTarget: string | undefined,
  currentAppBundleId: string | undefined,
): Promise<string | undefined> {
  if (!isApplePlatform(device.platform) || !openTarget) return undefined;
  if (isDeepLinkTarget(openTarget)) {
    if (isMacOs(device)) return undefined;
    if (device.kind === 'device') {
      return resolveIosDeviceDeepLinkBundleId(currentAppBundleId, openTarget);
    }
    if (!isWebUrl(openTarget)) {
      return currentAppBundleId ?? (await resolveSimulatorDeepLinkBundleId(device, openTarget));
    }
    // simctl openurl opens a web URL in Safari, matching the real reader's Safari rule.
    return IOS_SAFARI_BUNDLE_ID;
  }
  try {
    const { resolveIosApp } = await import('@agent-device/platform-apple/app-resolution');
    return await resolveIosApp(device, openTarget);
  } catch {
    return undefined;
  }
}

async function resolveSimulatorDeepLinkBundleId(
  device: DeviceInfo,
  openTarget: string,
): Promise<string | undefined> {
  try {
    const { resolveIosSimulatorDeepLinkBundleId } =
      await import('@agent-device/platform-apple/app-resolution');
    return await resolveIosSimulatorDeepLinkBundleId(device, openTarget);
  } catch {
    return undefined;
  }
}

async function resolveAndroidPackage(
  device: DeviceInfo,
  openTarget: string | undefined,
): Promise<string | undefined> {
  if (device.platform !== 'android' || !openTarget) return undefined;
  try {
    // Dynamic like the Apple branch: suites register their mechanics mocks after this fixture's
    // module evaluates, so a static import would bind the unmocked leaf.
    const { resolveAndroidPackageForOpen } =
      await import('@agent-device/platform-android/mechanics');
    return await resolveAndroidPackageForOpen(device, openTarget);
  } catch {
    return undefined;
  }
}

function bundleIdFromOpenTarget(openTarget: string | undefined): string | undefined {
  const trimmed = openTarget?.trim();
  if (!trimmed || isDeepLinkTarget(trimmed) || !trimmed.includes('.')) return undefined;
  return trimmed;
}

/**
 * The claim-recovery gateway factory port: recovery transactions in daemon suites get a gateway
 * that binds nothing and reports every owner unavailable, because the suites assert the
 * transaction's decisions (retain, settle, refuse) around the gateway, not what a composed
 * platform gateway does on the device. `vi.fn` per call so a suite can count compositions and
 * hand its own unavailable bindings where recovery must proceed.
 */
export function daemonClaimRecoveryGatewayFixture(): ClaimRecoveryGatewayFactory {
  return vi.fn(() => unavailableDeviceRuntimeGateway);
}
