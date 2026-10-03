import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveAndroidApp } from './app-deployment-resolution.ts';
import { getAndroidAppState } from './window-state.ts';

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

/** A deep-link open can foreground a different package than the one requested; read it back. */
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
    const foreground = await getAndroidAppState(device);
    return foreground.package?.trim() || currentAppBundleId;
  } catch {
    return currentAppBundleId;
  }
}
