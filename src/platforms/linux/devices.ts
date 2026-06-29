import { hostname } from 'node:os';
import type { DeviceInfo } from '../../kernel/device.ts';

export async function listLinuxDevices(): Promise<DeviceInfo[]> {
  if (process.platform !== 'linux') {
    return [];
  }

  return [
    {
      platform: 'linux',
      id: 'local',
      name: hostname(),
      kind: 'device',
      target: 'desktop',
      booted: true,
    },
  ];
}
