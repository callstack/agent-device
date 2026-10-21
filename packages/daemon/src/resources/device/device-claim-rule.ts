import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';

/**
 * The device-claim rule: what a runtime owner's kind selects at a claim gate.
 * `ordinary` acquires a host-local device claim, and `none` leaves the claim
 * store alone because the provider lease already excludes peers. The rule
 * follows the admitted runtime owner, never request metadata. A `macos-app`
 * lease binds a local app device (ADR 0035), so it takes the ordinary claim.
 */
export type DeviceClaimRule = 'ordinary' | 'none';

export function deviceClaimRuleForOwner(owner: RuntimeOwnerRef): DeviceClaimRule {
  switch (owner.kind) {
    case 'local-family':
      return 'ordinary';
    case 'provider-runtime':
      return 'none';
  }
}
