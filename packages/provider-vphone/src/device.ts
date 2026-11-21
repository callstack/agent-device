import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function buildVphoneDevice(lease: DeviceLease, machine: string): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: vphoneDeviceId(lease.leaseId),
    name: machine,
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
}

function vphoneDeviceId(leaseId: string): string {
  return `vphone:ios:${leaseId}`;
}

export function isVphoneDeviceId(value: string): boolean {
  return value.startsWith('vphone:ios:') && value.length > 'vphone:ios:'.length;
}
