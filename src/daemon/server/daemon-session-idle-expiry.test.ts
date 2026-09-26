import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  readIdleSessionTombstoneFile,
  resolveIdleSessionTombstonePath,
} from '../session-idle-tombstone.ts';
import { createSessionIdleExpiry } from './daemon-session-idle-expiry.ts';
import {
  createIdleExpiryHarness,
  CLAIM,
  NOW,
  WINDOW_MS,
} from '../__tests__/session-idle-expiry-harness.ts';
import {
  makeIosSession,
  makeRepairCompleteSession,
} from '../../__tests__/test-utils/session-factories.ts';
import { resolveDeviceClaimPath } from '../device/device-claim-paths.ts';

/**
 * #2833: what one expiry COMMITS, once it has run. Whether a session past its window is the kind that
 * may be expired at all, and once it is: its claim released, its record deleted, its repair
 * transaction committed, and a bounded marker naming the device left for the next command. Including
 * whether a settle that could not confirm the release is allowed to have forgotten anything.
 *
 * WHEN the reaper starts an expiry and how long it may take is
 * `daemon-session-idle-expiry-scheduling.test.ts`.
 */
const harness = createIdleExpiryHarness();
const {
  makeFixture,
  idleClaimedSession,
  unclaimedExpiredSession,
  sessionWithLiveClaim,
  claimFileHeld,
  runUntilIdle,
} = harness;

test('a session past its window releases its claim, is deleted, and leaves a marker naming its device', async () => {
  const fixture = makeFixture('agent-device-idle-expiry-settle-');
  const { sessionStore } = fixture;
  const { deviceClaim } = await sessionWithLiveClaim(fixture);
  assert.equal(claimFileHeld(deviceClaim), true, 'the fixture stands a claim that is really held');
  const settleSession = async () => {};

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    settleSession,
    now: () => NOW,
  });
  await runUntilIdle(controller, 10);

  // The device is what every other agent on the host waits for, so this — not the in-memory record —
  // is the promise the feature makes.
  assert.equal(claimFileHeld(deviceClaim), false, 'the expired claim must be released');
  assert.equal(sessionStore.get('default'), undefined);
  const marker = readIdleSessionTombstoneFile(
    resolveIdleSessionTombstonePath(sessionStore.resolveSessionDir('default')),
  );
  assert.equal(marker?.owner, 'default');
  assert.equal(marker?.deviceKey, deviceClaim.deviceKey);
  assert.equal(marker?.idleExpiryMs, WINDOW_MS);
  controller.cancel();
});

test('a settle that cannot confirm the claim gone keeps the session record standing', async () => {
  const fixture = makeFixture('agent-device-idle-expiry-claim-unconfirmed-');
  const { sessionStore } = fixture;
  const { deviceClaim } = await sessionWithLiveClaim(fixture);

  // A claim store this process cannot write into: the clear reaches NO verdict, which is different
  // information from a successor having taken the device.
  const claimsDir = path.dirname(resolveDeviceClaimPath(deviceClaim.deviceKey));
  fs.chmodSync(claimsDir, 0o500);
  try {
    const controller = createSessionIdleExpiry({
      sessionStore,
      idleExpiryMs: WINDOW_MS,
      executionLocks: new Map(),
      settleSession: async () => {},
      now: () => NOW,
    });
    await runUntilIdle(controller, 10);
    controller.cancel();
  } finally {
    fs.chmodSync(claimsDir, 0o700);
  }

  // Deleting the record here would leave a claim owned by a live daemon that no longer knows it holds
  // it — un-reclaimable by `device release --stale`, which proves staleness from owner liveness.
  assert.notEqual(
    sessionStore.get('default'),
    undefined,
    'an unconfirmed clear holds the record back for retry',
  );
  assert.equal(
    fs.existsSync(resolveIdleSessionTombstonePath(sessionStore.resolveSessionDir('default'))),
    false,
    'a settle that did not release the device must not report the session as expired',
  );
});

test('a claim that yields no attributable owner keeps the session record standing', async () => {
  const fixture = makeFixture('agent-device-idle-expiry-unattributable-');
  const { sessionStore } = fixture;
  const { deviceClaim } = await sessionWithLiveClaim(fixture);
  // The record this daemon wrote is now unreadable. The clear therefore learns nothing about whether
  // its claim is gone, which is a different answer from a successor owning the device — and only that
  // successor case may justify forgetting a session whose daemon is still alive.
  fs.writeFileSync(resolveDeviceClaimPath(deviceClaim.deviceKey), '{bad json');

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    settleSession: async () => {},
    now: () => NOW,
  });
  await runUntilIdle(controller, 10);
  controller.cancel();

  assert.notEqual(
    sessionStore.get('default'),
    undefined,
    'an unattributable record is still a claim this daemon may be holding',
  );
  assert.equal(
    fs.existsSync(resolveIdleSessionTombstonePath(sessionStore.resolveSessionDir('default'))),
    false,
    'a device that was not confirmed free must not be reported as released',
  );
});

test('a settle that fails keeps the session and its claim, and retries on the next window', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-retry-');
  idleClaimedSession(sessionStore);
  let clock = NOW;
  let settleCalls = 0;

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    settleSession: async () => {
      settleCalls++;
      throw new Error('recorder would not finalize');
    },
    now: () => clock,
  });
  await runUntilIdle(controller, 10);

  // The session survives: deleting it would leave a claim owned by a process that no longer knows
  // what it holds — worse than not expiring at all.
  assert.equal(settleCalls, 1);
  assert.notEqual(sessionStore.get('default'), undefined);
  assert.equal(
    fs.existsSync(resolveIdleSessionTombstonePath(sessionStore.resolveSessionDir('default'))),
    false,
    'a failed settle must not tell the next caller the session is gone',
  );

  // The retry does not spin: the next attempt waits a full window rather than refiring at zero.
  controller.noteSessionsChanged();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settleCalls, 1, 'the retry is deferred, not immediate');

  clock = NOW + WINDOW_MS;
  controller.noteSessionsChanged();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settleCalls, 2, 'one full window later the reclaim is attempted again');
  controller.cancel();
});

test('a session shutdown finalized mid-settle is not also reported as expired', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-shutdown-race-');
  idleClaimedSession(sessionStore);

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    // Shutdown takes no execution lock: it tears the whole session set down directly, so it is the
    // one remover that can finish while a settle is still running.
    settleSession: async (_session, sessionName) => {
      sessionStore.delete(sessionName);
    },
    now: () => NOW,
  });
  await runUntilIdle(controller, 10);
  controller.cancel();

  assert.equal(
    fs.existsSync(resolveIdleSessionTombstonePath(sessionStore.resolveSessionDir('default'))),
    false,
    'shutdown closed this session; a marker would blame idleness',
  );
});

test('a session closed by its owner stops the retry clock tracking it', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-closed-retry-');
  idleClaimedSession(sessionStore);
  let settleCalls = 0;
  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    settleSession: async () => {
      settleCalls++;
      throw new Error('cleanup failed');
    },
    now: () => NOW,
  });
  await runUntilIdle(controller, 10);
  assert.equal(settleCalls, 1);

  sessionStore.delete('default');
  controller.noteSessionsChanged();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settleCalls, 1, 'nothing is left to retry once the session is gone');
  controller.cancel();
});

test('a settled session of another kind is never touched by the sweep', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-kind-');
  // Past its deadline in time, but holding a remote lease: that lease owns the device.
  sessionStore.set(
    'leased',
    makeIosSession('leased', {
      createdAt: NOW - WINDOW_MS - 1,
      deviceClaim: { ...CLAIM },
      lease: {
        leaseId: 'lease-1',
        tenantId: 'tenant-1',
        runId: 'run-1',
        expiresAt: NOW + WINDOW_MS,
      },
    }),
  );
  // Past its deadline too, but holding no claim: there is no device for another agent to wait on,
  // so there is nothing here an expiry could reclaim and nothing to release.
  sessionStore.set('plain', unclaimedExpiredSession('plain'));

  const settledNames: string[] = [];
  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    // Succeeds rather than throwing: a rejected settle leaves every record standing for retry, which
    // would let this pass read as a correct refusal even if the sweep had torn both sessions down.
    settleSession: async (_session, sessionName) => {
      settledNames.push(sessionName);
    },
    now: () => NOW,
  });
  await runUntilIdle(controller, 10);

  assert.deepEqual(settledNames, [], 'neither session is eligible, so neither is ever settled');
  assert.notEqual(sessionStore.get('leased'), undefined);
  assert.notEqual(sessionStore.get('plain'), undefined);
  controller.cancel();
});

test('a held-back settle leaves a repair transaction uncommitted, so a later pass can still publish it', async () => {
  const fixture = makeFixture('agent-device-idle-expiry-repair-held-');
  const { sessionStore } = fixture;
  const { deviceClaim } = await sessionWithLiveClaim(fixture);
  // A repair transaction that reached its last executable step: this is the state whose healed `.ad`
  // a teardown commits, and a commit is ONE-WAY — writing onto an already-committed transaction is an
  // idempotent no-op. Finalizing a settle that is about to be held back would therefore mark a
  // still-live session's script as published and no later teardown would ever publish it.
  const session = makeRepairCompleteSession('default', {
    createdAt: NOW - WINDOW_MS - 1,
    deviceClaim: { ...deviceClaim },
  });
  sessionStore.set('default', session);

  const claimsDir = path.dirname(resolveDeviceClaimPath(deviceClaim.deviceKey));
  fs.chmodSync(claimsDir, 0o500);
  try {
    const controller = createSessionIdleExpiry({
      sessionStore,
      idleExpiryMs: WINDOW_MS,
      executionLocks: new Map(),
      settleSession: async () => {},
      now: () => NOW,
    });
    await runUntilIdle(controller, 10);
    controller.cancel();
  } finally {
    fs.chmodSync(claimsDir, 0o700);
  }

  assert.notEqual(sessionStore.get('default'), undefined);
  assert.equal(
    session.scriptPublication?.kind === 'repair' ? session.scriptPublication.status : undefined,
    'complete',
    "a settle that released nothing must not publish this session's repair transaction",
  );
  assert.equal(
    fs.existsSync(path.join(sessionStore.resolveSessionDir('default'), 'repair-tombstone.json')),
    false,
    'and must not leave a repair tombstone for a transaction that never ended',
  );
});

test('a committed expiry finalizes the repair transaction it ends', async () => {
  const fixture = makeFixture('agent-device-idle-expiry-repair-committed-');
  const { sessionStore } = fixture;
  const { deviceClaim } = await sessionWithLiveClaim(fixture);
  const session = makeRepairCompleteSession('default', {
    createdAt: NOW - WINDOW_MS - 1,
    deviceClaim: { ...deviceClaim },
  });
  sessionStore.set('default', session);

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW_MS,
    executionLocks: new Map(),
    settleSession: async () => {},
    now: () => NOW,
  });
  await runUntilIdle(controller, 10);
  controller.cancel();

  assert.equal(sessionStore.get('default'), undefined);
  // ADR 0012 R7 binds an expiry like every other teardown: the healed script is committed, not
  // discarded with the record.
  assert.equal(
    session.scriptPublication?.kind === 'repair' ? session.scriptPublication.status : undefined,
    'committed',
  );
});

test('a settle that outlives its window is retried a full window after it ends, not after it started', async () => {
  const { sessionStore } = makeFixture('agent-device-idle-expiry-long-settle-retry-');
  idleClaimedSession(sessionStore);
  // No settle budget, so the failing settle writes the only deferral this session has: that is the
  // one whose clock is in question. A real clock throughout, because what is measured is a deferral
  // against wall time.
  const WINDOW = 120;
  let releaseSettle!: () => void;
  const settleHeld = new Promise<void>((resolve) => {
    releaseSettle = resolve;
  });
  let settles = 0;
  let settledAt = 0;

  const controller = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: WINDOW,
    executionLocks: new Map(),
    settleSession: async () => {
      settles++;
      await settleHeld;
      settledAt = Date.now();
      // The release itself fails: the session is held back for another attempt.
      throw new Error('the recorder would not stop');
    },
  });
  controller.noteSessionsChanged();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settles, 1);

  // The release outlives the window it was started inside. A deferral measured from the START of that
  // settle is already elapsed by the time it is written, so the reaper arms at zero delay and runs a
  // second teardown of a session whose first one only just failed.
  await new Promise((resolve) => setTimeout(resolve, WINDOW * 2));
  releaseSettle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(settledAt > 0, 'the settle reached its failure');
  assert.equal(settles, 1, 'a settle that just failed owes a full window, not zero delay');

  await new Promise((resolve) => setTimeout(resolve, WINDOW + 60));
  assert.equal(settles, 2, 'the window it was owed does come due');
  controller.cancel();
});
