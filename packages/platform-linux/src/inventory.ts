import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceInventoryHost, DeviceInventorySource } from '@agent-device/contracts/platform';

export function createLinuxInventory(host: DeviceInventoryHost): DeviceInventorySource {
  return {
    discover: async () => discoverLinuxDevices(host),
  };
}

function discoverLinuxDevices(host: DeviceInventoryHost): readonly DeviceInfo[] {
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
