import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';

export const DOUBLESPEED_PROVIDER = 'doublespeed';
const DOUBLESPEED_IOS_LEASE_BACKEND = 'ios-instance';

export function isDoublespeedLeaseBackend(backend: string): boolean {
  return backend === DOUBLESPEED_IOS_LEASE_BACKEND;
}

export function buildDoublespeedDevice(
  lease: DeviceLease,
  simulator: { id: string; device: string },
): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: doublespeedDeviceId(lease.leaseId),
    name: `Doublespeed ${simulator.device} ${simulator.id.slice(0, 8)}`,
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
}

export function parseDoublespeedDeviceId(value: string): { leaseId: string } | undefined {
  const [prefix, platform, leaseId] = value.split(':');
  if (prefix !== DOUBLESPEED_PROVIDER || platform !== 'ios' || !leaseId) return undefined;
  return { leaseId };
}

function doublespeedDeviceId(leaseId: string): string {
  return `${DOUBLESPEED_PROVIDER}:ios:${leaseId}`;
}

/**
 * The one device identity a Doublespeed runtime owns: a mobile iOS simulator carrying an id this
 * module itself would have built. Every owner, facts, and lifecycle module asks this single
 * definition so device-identity support cannot drift between them.
 */
export function isSupportedDoublespeedDevice(device: DeviceInfo): boolean {
  return (
    parseDoublespeedDeviceId(device.id) !== undefined &&
    device.platform === 'apple' &&
    device.appleOs === 'ios' &&
    device.kind === 'simulator' &&
    device.target === 'mobile' &&
    device.iosPhysicalDeviceBackend === undefined
  );
}
