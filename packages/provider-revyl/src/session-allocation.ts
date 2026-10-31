import type { LeaseLifecycleContext } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
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
 *
 * Both values go through {@link revylTextFlag}, which is the same canonicalizer connect stores them
 * with, so the persisted profile and the `start_device` body cannot differ by whitespace.
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

/** What one allocation asks Revyl to start: the app to install and the device to pick. */
export type RevylStartRequest = Readonly<{
  appUrl?: string;
  deviceModel?: string;
  osVersion?: string;
}>;

export function resolveRevylStartRequest(
  context: LeaseLifecycleContext | undefined,
  fallback: Readonly<{ deviceModel?: string; osVersion?: string }>,
): RevylStartRequest {
  const appUrl = resolveRevylAppUrl(context);
  return {
    ...(appUrl === undefined ? {} : { appUrl }),
    ...resolveRevylDeviceSelection(context, fallback),
  };
}

/**
 * Refuses an allocation that joins a lease whose device was started for a different app or device.
 * A field the joiner leaves unset accepts whatever the lease has; one it names has to match, because
 * the joiner would otherwise be handed a device it did not ask for.
 */
export function requireSameRevylStartRequest(
  leaseId: string,
  started: RevylStartRequest,
  joining: RevylStartRequest,
): void {
  const differing = (Object.keys(joining) as (keyof RevylStartRequest)[]).filter(
    (field) => joining[field] !== undefined && joining[field] !== started[field],
  );
  if (differing.length === 0) return;
  throw new AppError(
    'INVALID_ARGS',
    `Revyl lease ${leaseId} already has a device started for a different ${differing.join(', ')}.`,
    {
      reason: 'provider-lease-request-mismatch',
      leaseId,
      fields: differing,
      hint: 'Disconnect and connect again to rent a device for the new app or device selection.',
    },
  );
}

/** One text selection a profile or flag carries: trimmed, and absent when it is blank. */
export function revylTextFlag(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function optionalFlag(
  value: unknown,
  key: 'deviceModel' | 'osVersion',
): Readonly<{ [Name in 'deviceModel' | 'osVersion']?: string }> {
  const text = revylTextFlag(value);
  return text === undefined ? {} : { [key]: text };
}
