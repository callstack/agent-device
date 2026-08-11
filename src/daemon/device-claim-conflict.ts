import {
  isApplePlatform,
  publicPlatformString,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { shellQuoteIfNeeded } from '../utils/shell-quote.ts';
import {
  deviceClaimRequiresStaleInspection,
  type DeviceClaimClassification,
  type InspectedDeviceClaim,
} from './device-claim-inspection.ts';
import type { DaemonResponse } from './types.ts';
import { errorResponse } from './handlers/response.ts';

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

export function buildDeviceClaimConflictError(
  device: DeviceInfo,
  conflict: InspectedDeviceClaim,
): DaemonResponse {
  const owner = conflict.claim;
  const recoveryCommand = buildDeviceClaimInspectionCommand(device, conflict);
  const publicPlatform = owner
    ? publicPlatformString({ platform: owner.device.family, appleOs: owner.device.appleOs })
    : publicPlatformString(device);
  return errorResponse(
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
    },
    { hint: `Inspect the owner with: ${recoveryCommand}`, retriable: false },
  );
}

function conflictReason(
  classification: DeviceClaimClassification,
): 'DEVICE_CLAIM_LIVE_OWNER' | 'DEVICE_CLAIM_RECOVERY_PENDING' | 'DEVICE_CLAIM_OWNER_UNCERTAIN' {
  switch (classification) {
    case 'live':
      return 'DEVICE_CLAIM_LIVE_OWNER';
    case 'owner-process-dead':
      return 'DEVICE_CLAIM_RECOVERY_PENDING';
    case 'owner-process-reused':
    case 'owner-state-dir-gone':
    case 'unknown':
    case 'inconsistent':
      return 'DEVICE_CLAIM_OWNER_UNCERTAIN';
  }
}
