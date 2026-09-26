import { afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../session-store.ts';
import type { SessionState } from '../session-state.ts';
import type { createSessionIdleExpiry } from '../server/daemon-session-idle-expiry.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
  type IsolatedDeviceClaimStore,
} from '../../__tests__/test-utils/device-claim-store.ts';
import { acquireDeviceClaim, type DeviceClaimSessionOwnership } from '../device/device-claims.ts';
import { resolveDeviceClaimPath } from '../device/device-claim-paths.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

/** The inactivity window every harness session is already past, except where a test says otherwise. */
export const WINDOW_MS = 1_000;

/**
 * A wall-clock-scale base rather than a small synthetic one: the marker's own reader compares its
 * `expiresAt` against the real clock, exactly as the repair tombstone reader does.
 */
export const NOW = Date.now();

/** A claim-shaped record for a session that only needs to be HOLDING something. */
export const CLAIM = Object.freeze({
  deviceKey: 'ios:sim-1',
  ownerToken: 'token-1',
  ownerPid: 4242,
  ownerStartTime: null,
});

export type IdleExpiryFixture = Readonly<{
  sessionStore: SessionStore;
  /** This test's isolated claim store and daemon state dir, shared by the acquire and the sweep. */
  claims: IsolatedDeviceClaimStore;
}>;

/**
 * The claim and session scaffolding both idle-expiry test files need, with cleanup registered once.
 *
 * Claims are host-global by design, so reading and writing one has to be redirected away from the
 * developer's `~/.agent-device`. Every sweep reaches `clearDeviceClaim`, so the store is redirected
 * for every test rather than only the ones that inspect a claim. That path is resolved lazily, so
 * the LAST store this harness hands out is the one the calling test reads and writes.
 */
export function createIdleExpiryHarness(): Readonly<{
  makeFixture: (prefix: string) => IdleExpiryFixture;
  idleClaimedSession: (store: SessionStore, name?: string) => SessionState;
  unclaimedExpiredSession: (name: string) => SessionState;
  sessionWithLiveClaim: (
    fixture: IdleExpiryFixture,
    name?: string,
  ) => Promise<Readonly<{ session: SessionState; deviceClaim: DeviceClaimSessionOwnership }>>;
  claimFileHeld: (deviceClaim: DeviceClaimSessionOwnership) => boolean;
  runUntilIdle: (
    controller: ReturnType<typeof createSessionIdleExpiry>,
    ms: number,
  ) => Promise<void>;
}> {
  const claimStores = isolatedDeviceClaimStores('agent-device-idle-expiry-claim-');
  // Registers the cleanup hook at collection time; the per-test calls below share its root list.
  claimStores();

  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    makeFixture: (prefix) => {
      const root = mkdtempForTestSync(prefix);
      roots.push(root);
      return { sessionStore: new SessionStore(path.join(root, 'sessions')), claims: claimStores() };
    },
    idleClaimedSession: (store, name = 'default') => {
      const session = makeIosSession(name, {
        createdAt: NOW - WINDOW_MS - 1,
        deviceClaim: { ...CLAIM },
      });
      store.set(name, session);
      return session;
    },
    // Past its window on time alone, and holding no claim — nothing another agent waits on.
    unclaimedExpiredSession: (name) => makeIosSession(name, { createdAt: NOW - WINDOW_MS - 1 }),
    // Stands a real, currently-held claim and returns the session sitting on it. A fabricated token
    // would make the release a no-op that reports `ownership-changed`, which is precisely the outcome
    // that must not read as a device freed.
    sessionWithLiveClaim: async (fixture, name = 'default') => {
      const { stateDir } = fixture.claims;
      const acquired = await acquireDeviceClaim({
        device: IOS_SIMULATOR,
        session: name,
        workspace: stateDir,
        stateDir,
        reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
      });
      if (acquired.status !== 'acquired') {
        throw new Error(`expected an acquired claim, got ${acquired.status}`);
      }
      const session = makeIosSession(name, {
        createdAt: NOW - WINDOW_MS - 1,
        deviceClaim: acquired.ownership,
      });
      fixture.sessionStore.set(name, session);
      return { session, deviceClaim: acquired.ownership };
    },
    claimFileHeld: (deviceClaim) => fs.existsSync(resolveDeviceClaimPath(deviceClaim.deviceKey)),
    runUntilIdle: (controller, ms) => {
      controller.noteSessionsChanged();
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}
