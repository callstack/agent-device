import {
  isDeepLinkTarget,
  isWebUrl,
  resolveIosDeviceDeepLinkBundleId,
} from '@agent-device/contracts/command';
import { parseSessionSurface, type SessionSurface } from '@agent-device/contracts/session';
import { isMacOs, isApplePlatform, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

const LINUX_SUPPORTED_SURFACES = new Set<SessionSurface>(['app', 'desktop', 'frontmost-app']);

/**
 * Platform-owned surface classification for open. Daemon handlers retain only the public
 * error-response construction and session-policy choice of an existing surface.
 */
export function resolveRequestedOpenSurface(params: {
  device: DeviceInfo;
  surfaceFlag: string | undefined;
  openTarget: string | undefined;
  existingSurface?: SessionSurface;
}): SessionSurface {
  const { device, surfaceFlag, openTarget, existingSurface } = params;
  if (device.platform === 'linux') {
    return resolveLinuxOpenSurface(surfaceFlag, openTarget, existingSurface);
  }
  if (isMacOs(device)) {
    return resolveMacOsOpenSurface(surfaceFlag, openTarget, existingSurface);
  }
  return resolveNonDesktopOpenSurface(surfaceFlag);
}

function resolveLinuxOpenSurface(
  surfaceFlag: string | undefined,
  openTarget: string | undefined,
  existingSurface: SessionSurface | undefined,
): SessionSurface {
  if (!surfaceFlag) return existingSurface ?? 'app';
  const surface = parseSessionSurface(surfaceFlag);
  if (!LINUX_SUPPORTED_SURFACES.has(surface)) {
    throw new AppError(
      'INVALID_ARGS',
      `Linux supports --surface app, desktop, and frontmost-app (got "${surfaceFlag}")`,
    );
  }
  assertOpenSurfaceHasNoTarget(surface, openTarget);
  return surface;
}

function resolveMacOsOpenSurface(
  surfaceFlag: string | undefined,
  openTarget: string | undefined,
  existingSurface: SessionSurface | undefined,
): SessionSurface {
  if (!surfaceFlag) return existingSurface ?? 'app';
  const surface = parseSessionSurface(surfaceFlag);
  if (surface !== 'app' && surface !== 'menubar') {
    assertOpenSurfaceHasNoTarget(surface, openTarget);
  }
  return surface;
}

function resolveNonDesktopOpenSurface(surfaceFlag: string | undefined): SessionSurface {
  if (surfaceFlag) {
    throw new AppError('INVALID_ARGS', 'surface is only supported on macOS and Linux');
  }
  return 'app';
}

function assertOpenSurfaceHasNoTarget(
  surface: SessionSurface,
  openTarget: string | undefined,
): void {
  if (surface !== 'app' && surface !== 'menubar' && openTarget) {
    throw new AppError('INVALID_ARGS', `open --surface ${surface} does not accept an app target`);
  }
}

/** Platform-specific relaunch classification stays alongside target resolution. */
export async function validateOpenRelaunchTarget(params: {
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
    const { classifyAndroidAppTarget, formatAndroidInstalledPackageRequiredMessage } =
      await loadAndroidMechanics();
    if (classifyAndroidAppTarget(target) === 'binary') {
      return formatAndroidInstalledPackageRequiredMessage(target);
    }
  }
  return undefined;
}

async function resolveIosBundleIdForOpen(
  device: DeviceInfo,
  openTarget: string | undefined,
  currentAppBundleId?: string,
): Promise<string | undefined> {
  if (!isApplePlatform(device.platform) || !openTarget) return undefined;
  if (isDeepLinkTarget(openTarget)) {
    if (isMacOs(device)) return undefined;
    if (device.kind === 'device') {
      return resolveIosDeviceDeepLinkBundleId(currentAppBundleId, openTarget);
    }
    if (!isWebUrl(openTarget)) {
      return (
        currentAppBundleId ?? (await tryResolveIosSimulatorDeepLinkBundleId(device, openTarget))
      );
    }
    return undefined;
  }
  return await tryResolveIosAppBundleId(device, openTarget);
}

async function tryResolveIosSimulatorDeepLinkBundleId(
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

async function tryResolveIosAppBundleId(
  device: DeviceInfo,
  openTarget: string,
): Promise<string | undefined> {
  try {
    const { resolveIosApp } = await import('@agent-device/platform-apple/app-resolution');
    return await resolveIosApp(device, openTarget);
  } catch {
    return undefined;
  }
}

function shouldPreserveAndroidPackageContext(
  device: DeviceInfo,
  openTarget: string | undefined,
): boolean {
  return device.platform === 'android' && Boolean(openTarget && isDeepLinkTarget(openTarget));
}

/** Harmony's local target contract accepts an explicit dotted package without an adb lookup. */
function bundleIdFromOpenTarget(openTarget: string | undefined): string | undefined {
  const trimmed = openTarget?.trim();
  if (!trimmed || isDeepLinkTarget(trimmed) || !trimmed.includes('.')) return undefined;
  return trimmed;
}

export async function resolveSessionAppBundleIdForTarget(
  device: DeviceInfo,
  openTarget: string | undefined,
  currentAppBundleId: string | undefined,
): Promise<string | undefined> {
  if (device.platform === 'harmonyos') {
    return bundleIdFromOpenTarget(openTarget) ?? currentAppBundleId;
  }
  return (
    (await resolveIosBundleIdForOpen(device, openTarget, currentAppBundleId)) ??
    (await tryResolveAndroidPackageForOpen(device, openTarget)) ??
    (shouldPreserveAndroidPackageContext(device, openTarget) ? currentAppBundleId : undefined)
  );
}

async function tryResolveAndroidPackageForOpen(
  device: DeviceInfo,
  openTarget: string | undefined,
): Promise<string | undefined> {
  if (device.platform !== 'android' || !openTarget) return undefined;
  try {
    const { resolveAndroidPackageForOpen } = await loadAndroidMechanics();
    return await resolveAndroidPackageForOpen(device, openTarget);
  } catch {
    return undefined;
  }
}
