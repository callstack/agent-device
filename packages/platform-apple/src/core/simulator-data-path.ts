import path from 'node:path';
import { hostHomeDirectory } from '@agent-device/host-kit/host-file';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { simulatorAddressFor } from './simctl.ts';

/** The simulator's `data` directory, the root of its file system, as this host stores it. */
export function hostSimulatorDataPath(device: DeviceInfo): string {
  const { udid, simulatorSetPath } = simulatorAddressFor(device);
  const setPath =
    simulatorSetPath ?? path.join(hostHomeDirectory(), 'Library/Developer/CoreSimulator/Devices');
  return path.join(setPath, udid, 'data');
}
