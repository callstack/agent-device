/**
 * The refusal reasons a host-local device claim can answer with when another owner holds the
 * device. Replay reads them to tell an infrastructure conflict from a script failure.
 */
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
