import {
  isDeepLinkTarget,
  isWebUrl,
  resolveIosDeviceDeepLinkBundleId,
} from '@agent-device/contracts/command';
import {
  isIosFamily,
  isMacOs,
  isApplePlatform,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';

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

/**
 * #1658: a provider-backed iOS device has no local simctl/devicectl to resolve
 * an app NAME against, which is why the open path skips resolution there
 * entirely. Skipping it wholesale also dropped the case where the caller
 * already spelled the bundle id — `open com.example.app` against a cloud device
 * left the session with no app identity at all, so every appBundleId-gated
 * command (snapshot/diff first among them) refused a device that was perfectly
 * healthy. A dotted, non-deep-link target IS the bundle id under the same
 * convention the local resolver applies (resolveIosApp returns a dotted target
 * unchanged), so adopt it without any device round trip.
 */
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
  if (isIosFamily(device) && isActiveProviderDevice(device)) {
    // An explicit bundle-id target wins over the session's current app, exactly
    // as the local path does: resolveIosApp returns a dotted target unchanged
    // and never consults currentAppBundleId. Preferring the stored id instead
    // would leave `open com.a` then `open com.b` reporting com.a. Everything
    // this cannot name — deep links, display names, no target — still falls
    // back to the known id, which is what the local deep-link branches do too.
    return bundleIdFromOpenTarget(openTarget) ?? currentAppBundleId;
  }
  if (device.platform === 'harmonyos') {
    return bundleIdFromOpenTarget(openTarget) ?? currentAppBundleId;
  }
  return (
    (await resolveIosBundleIdForOpen(device, openTarget, currentAppBundleId)) ??
    (await resolveAndroidPackageForOpenFn(device, openTarget)) ??
    (shouldPreserveAndroidPackageContext(device, openTarget) ? currentAppBundleId : undefined)
  );
}
