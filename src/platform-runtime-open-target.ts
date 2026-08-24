import {
  isDeepLinkTarget,
  isWebUrl,
  resolveIosDeviceDeepLinkBundleId,
} from '@agent-device/contracts/command';
import { parseSessionSurface, type SessionSurface } from '@agent-device/contracts/session';
import { isMacOs, isApplePlatform, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const LINUX_SUPPORTED_SURFACES = new Set<SessionSurface>(['app', 'desktop', 'frontmost-app']);

export type ResolvedForegroundIosApp = Readonly<{
  device: DeviceInfo;
  app: Readonly<{ bundleId: string }>;
}>;

/**
 * Read-only foreground discovery used solely to enrich a snapshot session-not-found hint. Actual
 * `open --foreground` target probing runs through the admitted Apple lifecycle binding instead.
 */
export async function resolveSoleForegroundIosApp(
  options: Readonly<{ simulatorSetPath?: string }> = {},
): Promise<ResolvedForegroundIosApp | undefined> {
  const { listLocalDeviceInventory, shouldPropagateDeviceInventoryProbeError } =
    await import('./request/device-inventory-context.ts');
  try {
    const booted = await listLocalDeviceInventory({
      platform: 'ios',
      iosSimulatorSetPath: options.simulatorSetPath,
      kind: 'simulator',
      booted: true,
    });
    if (booted.length !== 1) return undefined;
    const [soleBootedDevice] = booted;
    if (!soleBootedDevice) return undefined;

    const { detectSoleRunningIosSimulatorApp } =
      await import('./platforms/apple/core/app-resolution.ts');
    const app = await detectSoleRunningIosSimulatorApp(soleBootedDevice);
    return app ? { device: soleBootedDevice, app } : undefined;
  } catch (error) {
    if (shouldPropagateDeviceInventoryProbeError(error)) throw error;
    return undefined;
  }
}

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
      await import('./platforms/android/open-target.ts');
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
    const { resolveIosSimulatorDeepLinkBundleId } = await import('./platforms/apple/core/apps.ts');
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
    const { resolveIosApp } = await import('./platforms/apple/core/apps.ts');
    return await resolveIosApp(device, openTarget);
  } catch {
    return undefined;
  }
}

export async function resolveAndroidPackageForOpen(
  device: DeviceInfo,
  openTarget: string | undefined,
): Promise<string | undefined> {
  if (device.platform !== 'android' || !openTarget || isDeepLinkTarget(openTarget))
    return undefined;
  try {
    const { resolveAndroidApp } = await import('./platforms/android/app-deployment-resolution.ts');
    const resolved = await resolveAndroidApp(device, openTarget);
    return resolved.type === 'package' ? resolved.value : undefined;
  } catch {
    return undefined;
  }
}

export async function inferAndroidPackageAfterOpen(
  device: DeviceInfo,
  openTarget: string | undefined,
  currentAppBundleId: string | undefined,
): Promise<string | undefined> {
  if (currentAppBundleId) return currentAppBundleId;
  if (device.platform !== 'android' || !openTarget || !isDeepLinkTarget(openTarget)) {
    return currentAppBundleId;
  }
  try {
    const { getAndroidAppState } = await import('./platforms/android/app-lifecycle.ts');
    const foreground = await getAndroidAppState(device);
    return foreground.package?.trim() || currentAppBundleId;
  } catch {
    return currentAppBundleId;
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
  resolveAndroidPackageForOpenFn: (
    device: DeviceInfo,
    openTarget: string | undefined,
  ) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (device.platform === 'harmonyos') {
    return bundleIdFromOpenTarget(openTarget) ?? currentAppBundleId;
  }
  return (
    (await resolveIosBundleIdForOpen(device, openTarget, currentAppBundleId)) ??
    (await resolveAndroidPackageForOpenFn(device, openTarget)) ??
    (shouldPreserveAndroidPackageContext(device, openTarget) ? currentAppBundleId : undefined)
  );
}
