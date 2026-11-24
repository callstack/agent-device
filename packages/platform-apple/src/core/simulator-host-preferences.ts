import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { hostHomeDirectory, readHostBinaryFile } from '@agent-device/host-kit/host-file';
import { parseApplePlist } from './plist.ts';
import { simulatorAddressFor } from './simctl.ts';
import { hasScopedAppleToolProvider } from './tool-provider.ts';

/**
 * Reads one preferences domain of a simulator from this host, without a guest call. `null` means
 * it could not be read locally: a missing or malformed file, or a scoped (remote) tool provider.
 */
export async function readHostSimulatorPreferences(
  device: DeviceInfo,
  domain: string,
): Promise<Record<string, unknown> | null> {
  if (hasScopedAppleToolProvider()) return null;
  try {
    const { udid, simulatorSetPath } = simulatorAddressFor(device);
    const setPath =
      simulatorSetPath ?? path.join(hostHomeDirectory(), 'Library/Developer/CoreSimulator/Devices');
    const file = path.join(setPath, udid, `data/Library/Preferences/${domain}.plist`);
    return await parseApplePlist(await readHostBinaryFile(file));
  } catch {
    return null;
  }
}
