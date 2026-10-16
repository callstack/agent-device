import type { CommandFlags } from '@agent-device/contracts/command';
import { hasExplicitDeviceIdentitySelector } from '@agent-device/kernel/device';

const DEVICE_FILTER_KEYS: ReadonlyArray<keyof CommandFlags> = ['platform', 'target'];

const LOCKABLE_DEVICE_SCOPE_KEYS: ReadonlyArray<keyof CommandFlags> = [
  'iosSimulatorDeviceSet',
  'androidDeviceAllowlist',
];

/**
 * Request-scoped lease and provider-discovery context. These say WHO may see which devices
 * (a lease or a provider client narrows the inventory the resolver can reach), never WHICH
 * device, so a lane that rebuilds a selector must forward them or resolution silently
 * widens outside the lease. `device-selector-intent` classifies selectors; this is the one
 * read that keeps that classification's non-identity discovery keys together.
 */
export type LeaseDiscoveryContext = {
  leaseId?: string;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

const LEASE_DISCOVERY_KEYS = [
  'leaseId',
  'leaseProvider',
  'deviceKey',
  'clientId',
] as const satisfies ReadonlyArray<keyof LeaseDiscoveryContext & keyof CommandFlags>;

export function leaseDiscoveryContextFromFlags(
  flags: CommandFlags | undefined,
): LeaseDiscoveryContext {
  if (!flags) return {};
  const context: Record<string, string> = {};
  for (const key of LEASE_DISCOVERY_KEYS) {
    const value = flags[key];
    if (typeof value === 'string' && value.trim().length > 0) context[key] = value;
  }
  return context;
}

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
