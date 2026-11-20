import { createHash } from 'node:crypto';
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

/** Names this derivation, so a re-issue can change it without colliding with ids already issued. */
const REVYL_SESSION_ID_NAMESPACE = 'agent-device:revyl:session:v1';

/**
 * The session id one lease's device is started and stopped under.
 *
 * Revyl's `start_device` takes a caller-generated `session_id` and uses it as the session's canonical
 * identity, which is what Revyl's own clients do for a hosted session. Deriving it from the lease id
 * therefore gives the runtime a durable identity for one lease: an expired-lease recovery in a process
 * that never started the device can name the session it has to stop.
 *
 * It is a UUID because that is the field's declared format, and it is a hash rather than the lease id
 * itself because two daemons that rent for the same account must derive the same id for the same lease
 * and never collide across providers. Revyl's UUID regex accepts lowercase hex with the version and
 * variant bits set.
 */
export function revylSessionIdForLease(leaseId: string): string {
  const digest = createHash('sha256')
    .update(`${REVYL_SESSION_ID_NAMESPACE}:${leaseId}`)
    .digest('hex');
  const hex = `${digest.slice(0, 32)}`;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
