import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';

/** The two device kinds Revyl rents, spelled the way its API spells `platform`. */
export type RevylPlatform = 'ios' | 'android';

export const REVYL_PROVIDER = 'revyl';

/**
 * The snapshot channel each platform's `hierarchy` XML is presented on. Revyl answers the iOS
 * hierarchy with XCUITest-style XML and the Android hierarchy with a uiautomator dump, so each
 * platform reuses the reader that already parses that shape.
 */
export const REVYL_SNAPSHOT_CHANNEL = {
  ios: 'xctest',
  android: 'android',
} as const;

/** Revyl picks the device from the platform, an optional model and OS version, and an app URL. */
export function platformForRevylLeaseBackend(backend: string): RevylPlatform | undefined {
  if (backend === 'ios-instance') return 'ios';
  if (backend === 'android-instance') return 'android';
  return undefined;
}

export function buildRevylDevice(
  platform: RevylPlatform,
  lease: DeviceLease,
  runId: string,
): DeviceInfo {
  return {
    platform: platform === 'ios' ? 'apple' : 'android',
    ...(platform === 'ios' ? { appleOs: 'ios' as const } : {}),
    id: revylDeviceId(platform, lease.leaseId),
    name: `Revyl ${platform} ${runId.slice(0, 8)}`,
    kind: platform === 'ios' ? 'simulator' : 'emulator',
    target: 'mobile',
    booted: true,
  };
}

export function parseRevylDeviceId(
  value: string,
): { platform: RevylPlatform; leaseId: string } | undefined {
  const [prefix, platform, leaseId] = value.split(':');
  if (prefix !== REVYL_PROVIDER) return undefined;
  if (platform !== 'ios' && platform !== 'android') return undefined;
  if (!leaseId) return undefined;
  return { platform, leaseId };
}

function revylDeviceId(platform: RevylPlatform, leaseId: string): string {
  return `${REVYL_PROVIDER}:${platform}:${leaseId}`;
}

/**
 * The exact mobile device identities a Revyl runtime can own: an id this module would have built,
 * on the device shape that id's platform implies.
 */
export function isSupportedRevylRuntimeDevice(device: DeviceInfo): boolean {
  const parsed = parseRevylDeviceId(device.id);
  if (!parsed || device.target !== 'mobile') return false;
  return parsed.platform === 'ios'
    ? device.platform === 'apple' &&
        device.appleOs === 'ios' &&
        device.kind === 'simulator' &&
        device.iosPhysicalDeviceBackend === undefined
    : device.platform === 'android' &&
        device.appleOs === undefined &&
        device.kind === 'emulator' &&
        device.iosPhysicalDeviceBackend === undefined;
}
