import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DeviceInventoryHostFor,
  DeviceInventorySource,
} from '@agent-device/contracts/platform';

export function createLinuxInventory(host: DeviceInventoryHostFor<'linux'>): DeviceInventorySource {
  return {
    discover: async () => discoverLinuxDevices(host),
  };
}

function discoverLinuxDevices(host: DeviceInventoryHostFor<'linux'>): readonly DeviceInfo[] {
  if (host.hostOs !== 'linux') return [];
  const device: DeviceInfo = {
    platform: 'linux',
    id: 'local',
    name: host.hostName,
    kind: 'device',
    target: 'desktop',
    booted: true,
  };
  return [device];
}
