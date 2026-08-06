import type { CommandFlags } from '@agent-device/contracts/command';

const EXPLICIT_DEVICE_SELECTOR_KEYS: ReadonlyArray<keyof CommandFlags> = [
  'platform',
  'target',
  'device',
  'udid',
  'serial',
];

const LOCKABLE_DEVICE_SELECTOR_KEYS: ReadonlyArray<keyof CommandFlags> = [
  ...EXPLICIT_DEVICE_SELECTOR_KEYS,
  'iosSimulatorDeviceSet',
  'androidDeviceAllowlist',
];

export function hasExplicitDeviceSelector(flags: CommandFlags | undefined): boolean {
  return hasAnySelectorValue(flags, EXPLICIT_DEVICE_SELECTOR_KEYS);
}

export function hasLockableDeviceSelector(flags: CommandFlags | undefined): boolean {
  return hasAnySelectorValue(flags, LOCKABLE_DEVICE_SELECTOR_KEYS);
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
