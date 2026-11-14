import type {
  DeviceClaimAdmission,
  inspectDeviceClaimAdmission as InspectDeviceClaimAdmission,
  inspectNewSessionAdmission as InspectNewSessionAdmission,
} from './device-claim-admission.ts';
import type { ClaimRecoveryRetentionReason } from './device-claim-reconciliation.ts';

export type { ClaimRecoveryGatewayFactory } from './claim-recovery-gateway.ts';
export type { ClaimRecoveryRetentionReason, DeviceClaimAdmission };
export {
  inspectDeviceClaimRecovery,
  type ClaimRecoveryInspection,
} from './device-claim-reconciliation.ts';
export {
  createOwnerScopedDeviceClaimReconciler,
  type OwnerScopedClaimRecoveryComposer,
} from './device-claim-owner-recovery.ts';
export { createRecoveryPlatformScope } from './recovery-platform-scope.ts';

/**
 * The acquisition admission verdict, loaded on demand: only the admission check and
 * `device status` ask, and the daemon evaluating this entry never loads it eagerly.
 */
export async function inspectDeviceClaimAdmission(
  params: Parameters<typeof InspectDeviceClaimAdmission>[0],
): Promise<DeviceClaimAdmission> {
  return (await import('./device-claim-admission.ts')).inspectDeviceClaimAdmission(params);
}

export async function inspectNewSessionAdmission(
  params: Parameters<typeof InspectNewSessionAdmission>[0],
): Promise<DeviceClaimAdmission> {
  return (await import('./device-claim-admission.ts')).inspectNewSessionAdmission(params);
}
