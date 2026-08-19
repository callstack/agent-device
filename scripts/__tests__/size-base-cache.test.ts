import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import {
  CLAIM_IDENTITY,
  acquireBaseClaim,
  claimPath,
  readClaimIdentity,
  removeAbandonedClaim,
  takeoverPath,
} from '../size-base-cache.mjs';

// The claim protocol on its own: pure filesystem, no git and no subprocess, so the dangerous
// interleavings can be planted directly instead of hoped for under load. The orchestration this
// protects (worktree reuse, eviction, build stamping) is covered by size-report-base.test.ts.

const NEVER_A_PID = 2_147_483_647; // outside every platform's pid range: dead by construction
const ABANDONED = `${NEVER_A_PID}:abandoned`;
const OTHER_LIVE = `${process.pid}:another-run`;

let entry: string;

beforeEach(() => {
  entry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'size-base-cache-')), 'abc123456789');
});

afterEach(() => {
  fs.rmSync(path.dirname(entry), { recursive: true, force: true });
});

test('an unclaimed entry is claimed, names this run, and is released', () => {
  const release = acquireBaseClaim(entry, 'abc123456');
  assert.equal(readClaimIdentity(claimPath(entry)), CLAIM_IDENTITY);
  release();
  assert.equal(readClaimIdentity(claimPath(entry)), undefined);
});

test('a claim held by a live run is refused, and nothing about it is touched', () => {
  fs.symlinkSync(OTHER_LIVE, claimPath(entry));
  assert.throws(() => acquireBaseClaim(entry, 'abc123456'), /is using base abc123456/);
  assert.equal(readClaimIdentity(claimPath(entry)), OTHER_LIVE, 'the live claim survives');
});

test('an abandoned claim is taken over', () => {
  fs.symlinkSync(ABANDONED, claimPath(entry));
  const release = acquireBaseClaim(entry, 'abc123456');
  assert.equal(readClaimIdentity(claimPath(entry)), CLAIM_IDENTITY);
  release();
});

test('the exact interleaving: an abandoned claim replaced by a live one is never deleted', () => {
  // The window the protocol has to survive — observe abandoned, then another run takes over
  // before the removal. `removeAbandonedClaim` re-verifies under the takeover mutex, so the
  // replacement it finds is reported, not unlinked.
  fs.symlinkSync(ABANDONED, claimPath(entry));
  const observed = readClaimIdentity(claimPath(entry));
  // …the replacement lands here, in the window between observing and removing…
  fs.unlinkSync(claimPath(entry));
  fs.symlinkSync(OTHER_LIVE, claimPath(entry));

  assert.equal(removeAbandonedClaim(entry, observed), 'changed');
  assert.equal(readClaimIdentity(claimPath(entry)), OTHER_LIVE, 'the replacement is intact');
  // And the full acquire path refuses rather than stealing it.
  assert.throws(() => acquireBaseClaim(entry, 'abc123456'), /is using base abc123456/);
  assert.equal(readClaimIdentity(claimPath(entry)), OTHER_LIVE);
});

test('removal cannot run at all while another run holds the takeover mutex', () => {
  // A second taker is mid-takeover: the mutex is held, so this run must not remove anything,
  // and after CLAIM_ATTEMPTS it reports the contention instead of forcing its way in.
  fs.symlinkSync(ABANDONED, claimPath(entry));
  fs.mkdirSync(takeoverPath(entry));
  try {
    assert.equal(removeAbandonedClaim(entry, ABANDONED), 'busy');
    assert.equal(readClaimIdentity(claimPath(entry)), ABANDONED, 'untouched while contended');
    assert.throws(() => acquireBaseClaim(entry, 'abc123456'), /taking over the abandoned claim/);
    assert.equal(readClaimIdentity(claimPath(entry)), ABANDONED);
  } finally {
    fs.rmSync(takeoverPath(entry), { recursive: true, force: true });
  }
  // Once the other taker finishes, the entry is claimable again.
  const release = acquireBaseClaim(entry, 'abc123456');
  assert.equal(readClaimIdentity(claimPath(entry)), CLAIM_IDENTITY);
  release();
});

test('a delayed takeover holder is never displaced, however old its mutex looks', () => {
  // The interleaving that age-based reclamation created: holder A is merely slow — paused, or
  // SIGSTOPed past any threshold — while still inside the section. Use the old implementation's
  // directory-shaped mutex so this is also a planted regression against that exact code: it would
  // reclaim the aged directory and enter concurrently. Reclaiming the mutex would put B inside too,
  // and then A's release could remove B's mutex and either could unlink the claim the other just
  // created. A mutex is therefore never taken from its holder, at any age.
  fs.symlinkSync(ABANDONED, claimPath(entry));
  fs.mkdirSync(takeoverPath(entry));
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(takeoverPath(entry), longAgo, longAgo);

  assert.equal(removeAbandonedClaim(entry, ABANDONED), 'busy');
  assert.equal(
    fs.lstatSync(takeoverPath(entry)).isDirectory(),
    true,
    "the holder's mutex is intact",
  );
  assert.equal(readClaimIdentity(claimPath(entry)), ABANDONED, 'and it removed nothing');
  assert.throws(() => acquireBaseClaim(entry, 'abc123456'), /taking over the abandoned claim/);
  assert.equal(fs.lstatSync(takeoverPath(entry)).isDirectory(), true);
});

test('a leaked mutex wedges only its own entry, and says how to clear it', () => {
  // The price of never reclaiming: one entry needs a human. The message has to name the path.
  fs.symlinkSync(ABANDONED, claimPath(entry));
  fs.symlinkSync(`${NEVER_A_PID}:leaked`, takeoverPath(entry));
  assert.throws(
    () => acquireBaseClaim(entry, 'abc123456'),
    new RegExp(`remove ${takeoverPath(entry).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  // A different entry is unaffected: the mutex is per entry, so nothing else is wedged.
  const other = path.join(path.dirname(entry), 'def987654321');
  const release = acquireBaseClaim(other, 'def987654');
  assert.equal(readClaimIdentity(claimPath(other)), CLAIM_IDENTITY);
  release();
});

test('release leaves a claim that has come to name another run alone', () => {
  const release = acquireBaseClaim(entry, 'abc123456');
  fs.unlinkSync(claimPath(entry));
  fs.symlinkSync(OTHER_LIVE, claimPath(entry));
  release();
  assert.equal(readClaimIdentity(claimPath(entry)), OTHER_LIVE, "another run's claim survives");
});

test('a stray non-symlink at the claim path is cleared instead of wedging the entry', () => {
  fs.writeFileSync(claimPath(entry), 'not a claim of this scheme\n');
  const release = acquireBaseClaim(entry, 'abc123456');
  assert.equal(readClaimIdentity(claimPath(entry)), CLAIM_IDENTITY);
  release();
});
