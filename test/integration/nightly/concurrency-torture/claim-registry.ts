// In-memory model of the enforced host-global device claim (`src/daemon/device-claims.ts`).
//
// The production claim is a filesystem lock file guarded by a process lock, keyed
// by `canonicalLocalDeviceKey`. That is real I/O and a real OS lock — neither is
// seed-reproducible, and the torture lane is explicitly not wall-clock/I/O stress
// (#1416 out-of-scope). This model preserves the *invariants* the harness asserts:
//   - at most one live claim per device key;
//   - a claim is released only by its owner (ownerToken match), mirroring
//     `clearDeviceClaim`'s token/identity guard;
//   - a dead owner's claim must be reclaimable (owner-death reap).
// Mutual exclusion of the acquire/clear critical sections is provided by the
// scheduler mutex in the harness, not here, so this stays a plain synchronous map.

import crypto from 'node:crypto';

export type ClaimOwnership = {
  deviceKey: string;
  ownerToken: string;
  session: string;
};

type ClaimRecord = {
  deviceKey: string;
  ownerToken: string;
  session: string;
};

export type ClaimAcquireResult =
  | { ownership: ClaimOwnership; conflict?: undefined }
  | { ownership?: undefined; conflict: { session: string } };

export class InMemoryClaimRegistry {
  private readonly claims = new Map<string, ClaimRecord>();

  /**
   * Mirrors `acquireDeviceClaim`: re-acquiring your own claim is
   * idempotent, a foreign live claim is reported as a conflict, and a free key
   * is claimed with a fresh owner token.
   */
  acquire(deviceKey: string, session: string): ClaimAcquireResult {
    const existing = this.claims.get(deviceKey);
    if (existing) {
      if (existing.session === session) {
        return { ownership: { deviceKey, ownerToken: existing.ownerToken, session } };
      }
      return { conflict: { session: existing.session } };
    }
    const record: ClaimRecord = { deviceKey, ownerToken: crypto.randomUUID(), session };
    this.claims.set(deviceKey, record);
    return { ownership: { deviceKey, ownerToken: record.ownerToken, session } };
  }

  /** Mirrors `clearDeviceClaim`: only the token owner may clear. */
  clear(ownership: ClaimOwnership | undefined): void {
    if (!ownership) return;
    const existing = this.claims.get(ownership.deviceKey);
    if (!existing || existing.ownerToken !== ownership.ownerToken) return;
    this.claims.delete(ownership.deviceKey);
  }

  /** Owner of `deviceKey`, or undefined when free. */
  ownerSession(deviceKey: string): string | undefined {
    return this.claims.get(deviceKey)?.session;
  }

  /** Every live claim, for invariant checks. */
  snapshot(): { deviceKey: string; session: string }[] {
    return [...this.claims.values()].map((claim) => ({
      deviceKey: claim.deviceKey,
      session: claim.session,
    }));
  }
}
