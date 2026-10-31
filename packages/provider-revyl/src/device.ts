import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';

/** The two device kinds Revyl rents, spelled the way its API spells `platform`. */
export type RevylPlatform = 'ios' | 'android';

export const REVYL_PROVIDER = 'revyl';

/** The service name the connect report and a device's display name carry. */
export const REVYL_SERVICE = 'Revyl';

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
    // The run id whole: it is the handle an operator pastes into Revyl's console to find this device,
    // and a prefix that two sessions share would name the wrong one.
    name: `${REVYL_SERVICE} ${platform} ${runId}`,
    kind: platform === 'ios' ? 'simulator' : 'emulator',
    target: 'mobile',
    booted: true,
  };
}

export function parseRevylDeviceId(
  value: string,
): { platform: RevylPlatform; leaseId: string } | undefined {
  // Exactly the three segments `revylDeviceId` writes: an id with a fourth one is not ours, and
  // reading a lease id that contains a separator as one would address the wrong session.
  const parts = value.split(':');
  if (parts.length !== 3) return undefined;
  const [prefix, platform, leaseId] = parts;
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
