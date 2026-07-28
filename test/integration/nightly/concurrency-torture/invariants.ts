// Invariant checks for the concurrency torture lane (#1416), asserted after
// every seeded run. Kept separate from the world/operation logic so the
// real/model boundary each invariant relies on stays auditable in one read.
//
//   - same-device serialization: critical sections for one device never overlap
//   - every lock released after owner death: scheduler quiescent (no held/parked)
//   - session store consistent: one session per device, shadow/store parity
//   - no leaked leases: active leases ⇔ live sessions, one per device key
//   - no leaked claims: claims ⇔ live sessions, one per device key, all held
//   - no cross-session bleed: each stored session carries exactly its own
//     lease/claim/device, never a concurrent session's

import type { LeaseRegistry } from '../../../../src/daemon/lease-registry.ts';
import type { SessionStore } from '../../../../src/daemon/session-store.ts';

import type { SessionInstance } from './bindings.ts';

export type ClaimSnapshot = { deviceKey: string; session: string };

export type InvariantFailure = {
  invariant: string;
  detail: string;
};

/** Read-only view of the world the invariant checks inspect. */
export type WorldView = {
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  claimSnapshot: readonly ClaimSnapshot[];
  claimOwner(deviceKey: string): string | undefined;
  instances: readonly SessionInstance[];
  isInstanceLive(instance: SessionInstance): boolean;
  deviceActive: ReadonlyMap<string, number>;
  deviceMaxActive: ReadonlyMap<string, number>;
  assertQuiescent(): void;
};

export function checkInvariants(view: WorldView): InvariantFailure[] {
  const checker = new InvariantChecker(view);
  return checker.run();
}

class InvariantChecker {
  private readonly failures: InvariantFailure[] = [];
  private readonly view: WorldView;

  constructor(view: WorldView) {
    this.view = view;
  }

  run(): InvariantFailure[] {
    this.checkSerialization();
    this.checkLocksReleased();
    this.checkStoreConsistency();
    this.checkNoLeakedLeases();
    this.checkNoLeakedClaims();
    this.checkNoCrossSessionBleed();
    return this.failures;
  }

  private fail(invariant: string, detail: string): void {
    this.failures.push({ invariant, detail });
  }

  private liveInstances(): SessionInstance[] {
    return this.view.instances.filter((instance) => this.view.isInstanceLive(instance));
  }

  /** Flags any device key that appears more than once across `deviceKeys`. */
  private assertUniquePerDevice(
    deviceKeys: readonly string[],
    invariant: string,
    noun: string,
  ): void {
    const byDevice = new Map<string, number>();
    for (const key of deviceKeys) byDevice.set(key, (byDevice.get(key) ?? 0) + 1);
    for (const [deviceKey, count] of byDevice) {
      if (count > 1) this.fail(invariant, `device ${deviceKey} has ${count} ${noun}`);
    }
  }

  private checkSerialization(): void {
    for (const [deviceId, max] of this.view.deviceMaxActive) {
      if (max > 1) {
        this.fail(
          'same-device serialization',
          `device ${deviceId} had ${max} overlapping critical sections`,
        );
      }
    }
    for (const [deviceId, active] of this.view.deviceActive) {
      if (active !== 0) {
        this.fail(
          'same-device serialization',
          `device ${deviceId} left ${active} critical sections open`,
        );
      }
    }
  }

  private checkLocksReleased(): void {
    try {
      this.view.assertQuiescent();
    } catch (error) {
      this.fail('every lock released after owner death', (error as Error).message);
    }
  }

  private checkStoreConsistency(): void {
    this.checkStoredSessionsUnique();
    this.checkShadowStoreParity();
  }

  private checkStoredSessionsUnique(): void {
    const seenDevices = new Map<string, string>();
    for (const session of this.view.sessionStore.values()) {
      if (session.name !== this.view.sessionStore.get(session.name)?.name) {
        this.fail('session store consistent', `session ${session.name} key/name mismatch`);
      }
      const priorName = seenDevices.get(session.device.id);
      if (priorName) {
        this.fail(
          'session store consistent',
          `device ${session.device.id} bound to both ${priorName} and ${session.name}`,
        );
      }
      seenDevices.set(session.device.id, session.name);
    }
  }

  private checkShadowStoreParity(): void {
    const liveInstances = this.liveInstances();
    for (const instance of liveInstances) {
      const stored = this.view.sessionStore.get(instance.name);
      if (!stored) {
        this.fail('session store consistent', `live instance ${instance.name} missing from store`);
      } else if (stored.lease?.leaseId !== instance.lease.leaseId) {
        this.fail('session store consistent', `stored ${instance.name} lease != shadow lease`);
      }
    }
    const storeCount = this.view.sessionStore.toArray().length;
    if (storeCount !== liveInstances.length) {
      this.fail(
        'session store consistent',
        `store has ${storeCount} sessions, shadow expects ${liveInstances.length}`,
      );
    }
  }

  private checkNoLeakedLeases(): void {
    const active = this.view.leaseRegistry.listActiveLeases();
    const liveLeaseIds = new Set(this.liveInstances().map((instance) => instance.lease.leaseId));
    for (const lease of active) {
      if (!liveLeaseIds.has(lease.leaseId)) {
        this.fail(
          'no leaked leases',
          `lease ${lease.leaseId} (device ${lease.deviceKey}) has no live session`,
        );
      }
    }
    for (const leaseId of liveLeaseIds) {
      if (!active.some((lease) => lease.leaseId === leaseId)) {
        this.fail('no leaked leases', `live session lease ${leaseId} missing from registry`);
      }
    }
    // Device exclusivity: at most one active lease per device key.
    const deviceKeys = active
      .map((lease) => lease.deviceKey)
      .filter((key): key is string => Boolean(key));
    this.assertUniquePerDevice(deviceKeys, 'no leaked leases', 'active leases');
  }

  private checkNoLeakedClaims(): void {
    const claims = this.view.claimSnapshot;
    for (const claim of claims) {
      if (!this.view.sessionStore.get(claim.session)) {
        this.fail(
          'no leaked claims',
          `claim on ${claim.deviceKey} owned by dead session ${claim.session}`,
        );
      }
    }
    this.assertUniquePerDevice(
      claims.map((claim) => claim.deviceKey),
      'no leaked claims',
      'claims',
    );
    this.checkLiveClaimsHeld();
  }

  private checkLiveClaimsHeld(): void {
    for (const session of this.view.sessionStore.values()) {
      if (!session.deviceClaim) continue;
      const owner = this.view.claimOwner(session.deviceClaim.deviceKey);
      if (owner !== session.name) {
        this.fail(
          'no leaked claims',
          `session ${session.name} claim not held (owner=${String(owner)})`,
        );
      }
    }
  }

  private checkNoCrossSessionBleed(): void {
    for (const instance of this.liveInstances()) {
      if (!this.view.isInstanceLive(instance)) continue;
      const stored = this.view.sessionStore.get(instance.name);
      if (!stored) continue;
      if (stored.device.id !== instance.deviceId) {
        this.fail(
          'no cross-session bleed',
          `${instance.name} device ${stored.device.id} != ${instance.deviceId}`,
        );
      }
      if (stored.deviceClaim?.deviceKey !== instance.deviceKey) {
        this.fail('no cross-session bleed', `${instance.name} claim key mismatch`);
      }
      if (stored.lease?.clientId !== `c${instance.ownerClient}`) {
        this.fail(
          'no cross-session bleed',
          `${instance.name} lease clientId != owner c${instance.ownerClient}`,
        );
      }
    }
  }
}
