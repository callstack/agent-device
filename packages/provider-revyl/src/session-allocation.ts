import type { LeaseLifecycleContext } from '@agent-device/contracts/device';
import { rejectRefusedProviderProfileFields } from '@agent-device/contracts/provider-profile-fields';
import { REVYL_PROFILE_FIELDS } from './profile-fields.ts';

/**
 * Refuses the connect flags Revyl has no field for, so a flag that would be ignored is reported
 * instead of dropped. Runs before a lease is reused as well as before a device is started: a repeat
 * allocation carries flags of its own and Revyl reads none of them either way.
 */
export function rejectRefusedRevylProfileFields(context?: LeaseLifecycleContext): void {
  rejectRefusedProviderProfileFields(context?.flags, REVYL_PROFILE_FIELDS);
}

/**
 * The app to install at `start_device`. Revyl's install action takes a URL, so the profile's app
 * reference is already one.
 */
export function resolveRevylAppUrl(context?: LeaseLifecycleContext): string | undefined {
  const value = context?.initialApp;
  const app = typeof value === 'string' ? value.trim() : '';
  return app || undefined;
}

/**
 * The device Revyl should pick, read from the connect profile: `--device` names the model and
 * `--provider-os-version` the OS version. A profile that names neither lets Revyl choose
 * from its own pool. `fallback` carries what the runtime itself was built with, which an embedder
 * sets for every session it rents.
 */
export function resolveRevylDeviceSelection(
  context: LeaseLifecycleContext | undefined,
  fallback: Readonly<{ deviceModel?: string; osVersion?: string }>,
): Readonly<{ deviceModel?: string; osVersion?: string }> {
  return {
    ...fallback,
    ...optionalFlag(context?.flags?.device, 'deviceModel'),
    ...optionalFlag(context?.flags?.providerOsVersion, 'osVersion'),
  };
}

function optionalFlag(
  value: unknown,
  key: 'deviceModel' | 'osVersion',
): Readonly<{ [Name in 'deviceModel' | 'osVersion']?: string }> {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? { [key]: text } : {};
}
