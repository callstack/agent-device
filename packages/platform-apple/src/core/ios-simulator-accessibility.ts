import path from 'node:path';
import { isHandheldAppleSimulator, type DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { hostHomeDirectory, readHostBinaryFile } from '@agent-device/host-kit/host-file';
import { parseApplePlist } from './plist.ts';
import { buildSimctlArgsForDevice, simulatorAddressFor } from './simctl.ts';
import { hasScopedAppleToolProvider, runXcrun } from './tool-provider.ts';

const ACCESSIBILITY_PREPARE_TIMEOUT_MS = 2_000;

/**
 * Turns simulator app accessibility on, without booting the device. XCTest teardown turns it off,
 * and apps launched while it is off expose an empty accessibility tree. Rejects on failure.
 */
export async function enableIosSimulatorAppAccessibility(device: DeviceInfo): Promise<void> {
  if (!isHandheldAppleSimulator(device)) return;
  await runXcrun(
    buildSimctlArgsForDevice(device, [
      'spawn',
      device.id,
      'defaults',
      'write',
      'com.apple.Accessibility',
      'ApplicationAccessibilityEnabled',
      '-bool',
      'YES',
    ]),
    { timeoutMs: ACCESSIBILITY_PREPARE_TIMEOUT_MS },
  );
}

/**
 * Before a launch: writes only when the simulator's preferences on this host say app accessibility
 * is off, because a guest write costs about a second. A failure only warns, so it never blocks a
 * launch that worked before.
 */
export async function prepareIosSimulatorAccessibility(device: DeviceInfo): Promise<void> {
  if (!isHandheldAppleSimulator(device)) return;
  if ((await readHostAppAccessibility(device)) === 'enabled') return;
  try {
    await enableIosSimulatorAppAccessibility(device);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_simulator_accessibility_prepare_failed',
      data: { deviceId: device.id, error: normalizeError(error) },
    });
  }
}

/**
 * Reads the simulator's accessibility preferences file from this host. An absent key is how a
 * never-used simulator starts, and apps expose their tree there. Anything that cannot be read
 * locally, including a scoped (remote) tool provider, is `unknown` so the caller writes.
 */
async function readHostAppAccessibility(
  device: DeviceInfo,
): Promise<'enabled' | 'disabled' | 'unknown'> {
  if (hasScopedAppleToolProvider()) return 'unknown';
  try {
    const { udid, simulatorSetPath } = simulatorAddressFor(device);
    const setPath =
      simulatorSetPath ?? path.join(hostHomeDirectory(), 'Library/Developer/CoreSimulator/Devices');
    const preferences = path.join(
      setPath,
      udid,
      'data/Library/Preferences/com.apple.Accessibility.plist',
    );
    const parsed = await parseApplePlist(await readHostBinaryFile(preferences));
    if (!parsed) return 'unknown';
    const value = parsed.ApplicationAccessibilityEnabled;
    if (value === undefined || value === true || value === 1) return 'enabled';
    if (value === false || value === 0) return 'disabled';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
