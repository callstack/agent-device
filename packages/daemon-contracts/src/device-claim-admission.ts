import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { EnvMap } from '@agent-device/kernel/source-value';

import type { InspectedDeviceClaim } from './device-claim-inspection.ts';
import {
  inspectDeviceClaimRecovery,
  type ClaimRecoveryInspection,
  type ClaimRecoveryRetentionReason,
} from './device-claim-reconciliation.ts';
import type { DeviceClaim } from './device-claim-record.ts';
import {
  inspectDeviceClaimAcquisition,
  type ClaimAcquisitionInspectionParams,
} from './device-claims.ts';

/**
 * What the acquisition path would do with the claims of a device, decided without a side effect:
 * `refused` names the claim that wins the refusal, in the order an acquisition reaches the claims;
 * `admitted` lists the claims it would settle first. Admission and `device status` both ask this,
 * so neither restates the order, the canonical claim path, or the abandoned-claim and read-failure
 * rules {@link inspectDeviceClaimAcquisition} applies. Acquisition itself decides again under its
 * claim locks.
 */
export type DeviceClaimAdmission =
  | {
      status: 'admitted';
      reclaimed: readonly Readonly<{ claim: DeviceClaim; recovery?: ClaimRecoveryInspection }>[];
    }
  | {
      status: 'refused';
      conflict: InspectedDeviceClaim;
      retainedBy?: ClaimRecoveryRetentionReason;
    };

export async function inspectDeviceClaimAdmission(
  params: ClaimAcquisitionInspectionParams & {
    /** Checks a claim's durable resources before a gateway is composed; defaults to the plain inspection. */
    inspectRecovery?: (claim: DeviceClaim) => ClaimRecoveryInspection | undefined;
  },
): Promise<DeviceClaimAdmission> {
  const { inspectRecovery = inspectDeviceClaimRecovery, ...acquisition } = params;
  const reclaimed: { claim: DeviceClaim; recovery?: ClaimRecoveryInspection }[] = [];
  for (const settlement of await inspectDeviceClaimAcquisition(acquisition)) {
    if (settlement.status === 'conflict')
      return { status: 'refused', conflict: settlement.conflict };
    if (settlement.status !== 'reconcile') continue;
    const recovery = inspectRecovery(settlement.claim);
    if (recovery?.status === 'retained') {
      return { status: 'refused', conflict: settlement.conflict, retainedBy: recovery.reason };
    }
    reclaimed.push({ claim: settlement.claim, ...(recovery ? { recovery } : {}) });
  }
  return { status: 'admitted', reclaimed };
}

/**
 * {@link inspectDeviceClaimAdmission} for a NEW session of a daemon that holds nothing: no claim is
 * its own, and no abandoned claim belongs to it, so a running owner of any claim blocks. A reporter
 * passes no boot observer and never reads a reboot as proof.
 */
export async function inspectNewSessionAdmission(params: {
  device: DeviceInfo;
  env: EnvMap;
}): Promise<DeviceClaimAdmission> {
  return await inspectDeviceClaimAdmission({
    device: params.device,
    command: 'open',
    session: 'device-status',
    workspace: path.sep,
    stateDir: '',
    env: params.env,
    coveredClaimIsOwnedByRequest: () => false,
  });
}
