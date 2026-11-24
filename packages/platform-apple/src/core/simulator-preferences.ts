import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { hostHomeDirectory, readHostBinaryFile } from '@agent-device/host-kit/host-file';
import { parseApplePlist } from './plist.ts';
import { buildSimctlArgsForDevice, simulatorAddressFor } from './simctl.ts';
import { hasScopedAppleToolProvider, runXcrun } from './tool-provider.ts';

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

/**
 * Sets a boolean preference to YES inside the simulator through `defaults`. Rejects when the write
 * fails, times out, or exits non-zero, on a local or a scoped (remote) tool provider.
 */
export async function enableSimulatorBoolPreference(
  device: DeviceInfo,
  preference: { domain: string; key: string; timeoutMs: number },
): Promise<void> {
  await runXcrun(
    buildSimctlArgsForDevice(device, [
      'spawn',
      device.id,
      'defaults',
      'write',
      preference.domain,
      preference.key,
      '-bool',
      'YES',
    ]),
    { timeoutMs: preference.timeoutMs },
  );
}
