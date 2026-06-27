import os from 'node:os';
import type { DeviceInfo } from '../../utils/device.ts';

const HOST_MAC_DEVICE_ID = 'host-macos-local';

export function buildHostMacDevice(): DeviceInfo {
  return {
    platform: 'macos',
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
