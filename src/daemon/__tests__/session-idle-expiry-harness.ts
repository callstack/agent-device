import { afterEach, assert } from 'vitest';
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
  /**
   * Triggers a sweep and waits `ms` for nothing in particular.
   *
   * This is a BOUND on absence, not a wait for completion: use it only for the assertions that
   * something did NOT happen, where there is no outcome to look for. Anything that asserts a settle
   * landed goes through {@link waitFor} instead, because a fixed sleep here is a race the CI machine
   * wins or loses, and this suite performs real filesystem work per settle.
   */
  runUntilIdle: (
    controller: ReturnType<typeof createSessionIdleExpiry>,
    ms: number,
  ) => Promise<void>;
  /**
   * Gives an expiry that is blocked on something a moment to produce an outcome it must NOT produce.
   *
   * A bounded wait on ABSENCE, which has no fact to poll for. It is honest only because the calling
   * test then also awaits {@link createSweepBarrier.swept}: without that, the assertion below it would
   * be reading a sweep that had simply never started.
   */
  boundAbsence: (ms: number) => Promise<void>;
  /** Polls `probe` until it holds, so a test waits for the outcome it asserts rather than for time. */
  waitFor: (probe: () => boolean, description: string, timeoutMs?: number) => Promise<void>;
  /**
   * A barrier on sweep COMPLETION, for the tests that configure no settle budget.
   *
   * The composition scope wraps a sweep and awaits it, and a sweep with no budget awaits every
   * session's settle to the end, so a scope whose `run()` resolved is a sweep whose work is finished.
   * Passing this as `withinDiagnosticsScope` and then awaiting {@link createSweepBarrier.swept}
   * replaces a fixed sleep with the fact itself: the assertions that follow cannot be reading a
   * half-finished settle, and `sweeps` says a sweep really ran rather than merely never settled.
   */
  createSweepBarrier: () => Readonly<{
    withinDiagnosticsScope: (run: () => Promise<void>) => Promise<void>;
    swept: (atLeast?: number) => Promise<void>;
    sweeps: () => number;
  }>;
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
    createSweepBarrier: () => {
      let completed = 0;
      let wake: (() => void) | undefined;
      return {
        withinDiagnosticsScope: async (run) => {
          await run();
          completed++;
          wake?.();
        },
        swept: async (atLeast = 1) => {
          while (completed < atLeast) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
        sweeps: () => completed,
      };
    },
    boundAbsence: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    waitFor: async (probe, description, timeoutMs = 2_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (probe()) return;
        if (Date.now() >= deadline) {
          assert.fail(`timed out after ${timeoutMs}ms waiting for ${description}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    },
  };
}
