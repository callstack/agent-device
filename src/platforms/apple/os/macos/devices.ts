import os from 'node:os';
import type { DeviceInfo } from '../../../../kernel/device.ts';

const HOST_MAC_DEVICE_ID = 'host-macos-local';

export function buildHostMacDevice(): DeviceInfo {
  return {
    platform: 'apple',
    id: HOST_MAC_DEVICE_ID,
    name: os.hostname(),
    kind: 'device',
    target: 'desktop',
    appleOs: 'macos',
    booted: true,
  };
}

export async function listMacosDevices(): Promise<DeviceInfo[]> {
  return [buildHostMacDevice()];
}
