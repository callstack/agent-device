import type {
  DeviceAcquirability,
  inspectDeviceAcquirability as InspectDeviceAcquirability,
} from './device-claim-acquirability.ts';

export type { ClaimRecoveryGatewayFactory } from './claim-recovery-gateway.ts';
export type { DeviceAcquirabilityBlockReason } from './device-claim-acquirability.ts';
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
 * {@link InspectDeviceAcquirability}, loaded on demand: only `device status` asks, and the daemon
 * that evaluates this entry never does.
 */
export async function inspectDeviceAcquirability(
  params: Parameters<typeof InspectDeviceAcquirability>[0],
): Promise<DeviceAcquirability> {
  return (await import('./device-claim-acquirability.ts')).inspectDeviceAcquirability(params);
}
