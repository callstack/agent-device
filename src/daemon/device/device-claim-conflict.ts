import {
  isApplePlatform,
  publicPlatformString,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import {
  deviceClaimOwnerCannotRelease,
  deviceClaimRequiresStaleInspection,
  type DeviceClaimClassification,
  type InspectedDeviceClaim,
} from './device-claim-inspection.ts';
import type { DaemonResponse } from '../daemon-request.ts';
import { errorResponse } from '@agent-device/kernel/contracts';
import type { DeviceClaimConflictReason } from '@agent-device/contracts/device';

export function buildDeviceClaimInspectionCommand(
  device: DeviceInfo,
  conflict: Pick<InspectedDeviceClaim, 'claim' | 'classification'>,
  subcommand: 'status' | 'release' = 'status',
): string {
  const held = conflict.claim;
  const publicPlatform = held
    ? publicPlatformString({
        platform: held.device.family,
        appleOs: held.device.appleOs,
      })
    : publicPlatformString(device);
  const selector = isApplePlatform(device.platform) ? '--udid' : '--serial';
  return [
    `agent-device device ${subcommand}`,
    `--platform ${shellQuoteIfNeeded(publicPlatform)}`,
    `${selector} ${shellQuoteIfNeeded(device.id)}`,
    ...(subcommand === 'release' || deviceClaimRequiresStaleInspection(conflict.classification)
      ? ['--stale']
      : []),
  ].join(' ');
}

/**
 * The single construction of the foreign-claim refusal. `open` returns it as a
 * response; the request-scope binding seam throws it, because a
 * `transient-exclusive` command must never receive device operations at all.
 */
export function deviceClaimConflictError(
  device: DeviceInfo,
  conflict: InspectedDeviceClaim,
): AppError {
  const owner = conflict.claim;
  // A provably dead owner has an exact recovery: settle its resources and
  // release the claim. Everything else gets inspection, never a mutation.
  const recoveryCommand = buildDeviceClaimInspectionCommand(
    device,
    conflict,
    deviceClaimOwnerCannotRelease(conflict.classification) ? 'release' : 'status',
  );
  const publicPlatform = owner
    ? publicPlatformString({ platform: owner.device.family, appleOs: owner.device.appleOs })
    : publicPlatformString(device);
  return new AppError(
    'DEVICE_IN_USE',
    owner
      ? `${publicPlatform} device ${device.id} is owned by session "${owner.session}" in workspace "${owner.workspace}".`
      : `${device.name} has an ownership claim that could not be verified.`,
    {
      reason: conflictReason(conflict.classification),
      classification: conflict.classification,
      deviceKey: conflict.deviceKey,
      ...(owner
        ? {
            owner: {
              session: owner.session,
              workspace: owner.workspace,
              stateDir: owner.stateDir,
            },
          }
        : {}),
      recovery: { command: recoveryCommand },
      hint: deviceClaimOwnerCannotRelease(conflict.classification)
        ? `The recorded owner can no longer release this device; settle its resources and release the claim with: ${recoveryCommand}`
        : `Inspect the owner with: ${recoveryCommand}`,
      retriable: false,
    },
  );
}

export function buildDeviceClaimConflictError(
  device: DeviceInfo,
  conflict: InspectedDeviceClaim,
): DaemonResponse {
  return claimRefusalResponse(deviceClaimConflictError(device, conflict));
}

function claimRefusalResponse(error: AppError): DaemonResponse {
  const { hint, retriable, ...details } = error.details ?? {};
  return errorResponse(error.code, error.message, details, { hint, retriable });
}

function conflictReason(classification: DeviceClaimClassification): DeviceClaimConflictReason {
  switch (classification) {
    case 'live':
      return 'DEVICE_CLAIM_LIVE_OWNER';
    case 'owner-process-dead':
    case 'owner-daemon-superseded':
      return 'DEVICE_CLAIM_RECOVERY_PENDING';
    case 'owner-process-reused':
    case 'owner-state-dir-gone':
    case 'unknown':
    case 'inconsistent':
      return 'DEVICE_CLAIM_OWNER_UNCERTAIN';
  }
}
