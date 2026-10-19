export type { ClaimRecoveryGatewayFactory } from './claim-recovery-gateway.ts';
export {
  createOwnerScopedDeviceClaimReconciler,
  type OwnerScopedClaimRecoveryComposer,
} from './device-claim-owner-recovery.ts';
export { createRecoveryPlatformScope } from './recovery-platform-scope.ts';
