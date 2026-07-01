import {
  isDeepLinkTarget,
  isWebUrl,
  resolveIosDeviceDeepLinkBundleId,
} from '../../core/open-target.ts';
import { isMacOs, isApplePlatform, type DeviceInfo } from '../../kernel/device.ts';

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
      await import('../../platforms/apple/core/apps.ts');
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
    const { resolveIosApp } = await import('../../platforms/apple/core/apps.ts');
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
    const { resolveAndroidApp } = await import('../../platforms/android/app-lifecycle.ts');
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
    const { getAndroidAppState } = await import('../../platforms/android/app-lifecycle.ts');
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

export async function resolveSessionAppBundleIdForTarget(
  device: DeviceInfo,
  openTarget: string | undefined,
  currentAppBundleId: string | undefined,
  resolveAndroidPackageForOpenFn: (
    device: DeviceInfo,
    openTarget: string | undefined,
  ) => Promise<string | undefined>,
): Promise<string | undefined> {
  return (
    (await resolveIosBundleIdForOpen(device, openTarget, currentAppBundleId)) ??
    (await resolveAndroidPackageForOpenFn(device, openTarget)) ??
    (shouldPreserveAndroidPackageContext(device, openTarget) ? currentAppBundleId : undefined)
  );
}
