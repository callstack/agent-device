import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveAndroidApp } from './app-deployment-resolution.ts';
import { getAndroidAppState } from './window-state.ts';

const ANDROID_FRAMEWORK_PACKAGE = 'android';

/** Resolves an `open` target to an installed package; only an exact package match counts. */
export async function resolveAndroidPackageForOpen(
  device: DeviceInfo,
  openTarget: string | undefined,
): Promise<string | undefined> {
  if (device.platform !== 'android' || !openTarget || isDeepLinkTarget(openTarget))
    return undefined;
  try {
    const resolved = await resolveAndroidApp(device, openTarget);
    return resolved.type === 'package' ? resolved.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The package that owns an ADB open: the requested package, else the package `am start -W` reports
 * it launched, else the resumed foreground package when the launch named none. A framework
 * activity (a chooser or cross-profile forwarder) belongs to no app, so it leaves the open
 * unidentified.
 */
export async function inferAndroidPackageAfterOpen(
  device: DeviceInfo,
  openTarget: string | undefined,
  currentAppBundleId: string | undefined,
  launchedAppBundleId?: string,
): Promise<string | undefined> {
  if (currentAppBundleId) return currentAppBundleId;
  if (device.platform !== 'android' || !openTarget) return undefined;
  const owner = launchedAppBundleId ?? (await readForegroundPackage(device));
  return owner && owner !== ANDROID_FRAMEWORK_PACKAGE ? owner : undefined;
}

async function readForegroundPackage(device: DeviceInfo): Promise<string | undefined> {
  try {
    return (await getAndroidAppState(device)).package?.trim();
  } catch {
    return undefined;
  }
}
