import {
  isApplePlatform,
  publicPlatformString,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { shellQuoteIfNeeded } from '@agent-device/host-kit/command';
import {
  deviceClaimRequiresStaleInspection,
  type DeviceClaimClassification,
  type InspectedDeviceClaim,
} from './device-claim-inspection.ts';
import type { DaemonResponse } from './types.ts';
import { errorResponse } from './handlers/response.ts';

export type DeviceClaimConflictReason =
  | 'DEVICE_CLAIM_LIVE_OWNER'
  | 'DEVICE_CLAIM_RECOVERY_PENDING'
  | 'DEVICE_CLAIM_OWNER_UNCERTAIN';

const DEVICE_CLAIM_CONFLICT_REASONS = new Set<DeviceClaimConflictReason>([
  'DEVICE_CLAIM_LIVE_OWNER',
  'DEVICE_CLAIM_RECOVERY_PENDING',
  'DEVICE_CLAIM_OWNER_UNCERTAIN',
]);

export function isDeviceClaimConflictReason(value: unknown): value is DeviceClaimConflictReason {
  return DEVICE_CLAIM_CONFLICT_REASONS.has(value as DeviceClaimConflictReason);
}

export function buildDeviceClaimInspectionCommand(
  device: DeviceInfo,
  conflict: Pick<InspectedDeviceClaim, 'claim' | 'classification'>,
): string {
  const publicPlatform = conflict.claim
    ? publicPlatformString({
        platform: conflict.claim.device.family,
        appleOs: conflict.claim.device.appleOs,
      })
    : publicPlatformString(device);
  const selector = isApplePlatform(device.platform) ? '--udid' : '--serial';
  return [
    'agent-device device status',
    `--platform ${shellQuoteIfNeeded(publicPlatform)}`,
    `${selector} ${shellQuoteIfNeeded(device.id)}`,
    ...(deviceClaimRequiresStaleInspection(conflict.classification) ? ['--stale'] : []),
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
  const recoveryCommand = buildDeviceClaimInspectionCommand(device, conflict);
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
      hint: `Inspect the owner with: ${recoveryCommand}`,
      retriable: false,
    },
  );
}

export function buildDeviceClaimConflictError(
  device: DeviceInfo,
  conflict: InspectedDeviceClaim,
): DaemonResponse {
  const error = deviceClaimConflictError(device, conflict);
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
