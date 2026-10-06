import type { DeviceLease } from '@agent-device/contracts/device';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';

/**
 * The device-claim rule: what a runtime owner's kind selects at a claim gate.
 * `ordinary` acquires a host-local device claim, `allocator-held` executes only
 * under an existing allocator-held claim and never acquires or clears one, and
 * `none` leaves the claim store alone because the provider lease already
 * excludes peers. The rule follows the admitted runtime owner and lease, never
 * request metadata: a `macos-app` lease holds one app, not the host Mac
 * (ADR 0007), so the lease is all the exclusion it needs.
 */
export type DeviceClaimRule = 'ordinary' | 'allocator-held' | 'none';

export function deviceClaimRuleForOwner(
  owner: RuntimeOwnerRef,
  admittedLease?: Pick<DeviceLease, 'backend'>,
): DeviceClaimRule {
  if (admittedLease?.backend === 'macos-app') return 'none';
  switch (owner.kind) {
    case 'local-family':
      return 'ordinary';
    case 'managed-local':
      return 'allocator-held';
    case 'provider-runtime':
      return 'none';
  }
}
