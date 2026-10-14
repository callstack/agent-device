import type { CommandFlags } from '@agent-device/contracts/command';
import { hasExplicitDeviceIdentitySelector } from '@agent-device/kernel/device';

const DEVICE_FILTER_KEYS: ReadonlyArray<keyof CommandFlags> = ['platform', 'target'];

const LOCKABLE_DEVICE_SCOPE_KEYS: ReadonlyArray<keyof CommandFlags> = [
  'iosSimulatorDeviceSet',
  'androidDeviceAllowlist',
];

export function hasExplicitDeviceSelector(flags: CommandFlags | undefined): boolean {
  return hasExplicitDeviceIdentitySelector({
    deviceName: flags?.device,
    udid: flags?.udid,
    serial: flags?.serial,
  });
}

export function hasDeviceSelectionInput(flags: CommandFlags | undefined): boolean {
  return hasExplicitDeviceSelector(flags) || hasAnySelectorValue(flags, DEVICE_FILTER_KEYS);
}

export function hasLockableDeviceSelector(flags: CommandFlags | undefined): boolean {
  return hasDeviceSelectionInput(flags) || hasAnySelectorValue(flags, LOCKABLE_DEVICE_SCOPE_KEYS);
}

export function hasSelectorValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasAnySelectorValue(
  flags: CommandFlags | undefined,
  keys: ReadonlyArray<keyof CommandFlags>,
): boolean {
  if (!flags) return false;
  return keys.some((key) => hasSelectorValue(flags[key]));
}
