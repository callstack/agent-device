import { expect, test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { SessionState } from '../types.ts';
import {
  markSessionPartialRefsIssued,
  resolveRefStalenessWarning,
  setSessionSnapshot,
  setSnapshotLineage,
  STALE_SNAPSHOT_REFS_WARNING,
} from '../session-snapshot.ts';
import {
  activateCompleteRefFrame,
  activatePartialRefFrame,
  expireRefFrame,
  refFrame,
  refFrameEpoch,
  refFrameScope,
  refFrameState,
} from '../ref-frame.ts';

function makeSession(): SessionState {
  return {
    name: 'default',
    device: { id: 'device-1', name: 'Test Device', platform: 'apple' },
    createdAt: Date.now(),
    actions: [],
  } as unknown as SessionState;
}

function makeSnapshot(): SnapshotState {
  return { nodes: [], createdAt: Date.now(), backend: 'xctest' };
}

test('setSessionSnapshot advances the generation on every tree replacement (#1076 versioned refs)', () => {
  const session = makeSession();
  expect(session.snapshotGeneration).toBeUndefined();

  const first = makeSnapshot();
  setSessionSnapshot(session, first);
  // First bump of a lifetime is SEEDED at a random 6-digit base (see
  // nextSnapshotGeneration) — assert the range, not a literal.
  const seeded = session.snapshotGeneration!;
  expect(seeded).toBeGreaterThanOrEqual(100_000);
  expect(seeded).toBeLessThan(1_000_000);
  // ADR 0014: replacing the observation does NOT touch the ref frame.
  expect(session.refFrame).toBeUndefined();

  // Storing the SAME snapshot object again is not a replacement.
  setSessionSnapshot(session, first);
  expect(session.snapshotGeneration).toBe(seeded);

  // Within a lifetime the counter is strictly monotonic.
  setSessionSnapshot(session, makeSnapshot());
  expect(session.snapshotGeneration).toBe(seeded + 1);
});

test('a reopened session reseeds so pins from a previous lifetime do not silently collide', () => {
  const firstLifetime = makeSession();
  setSessionSnapshot(firstLifetime, makeSnapshot());
  const oldGeneration = firstLifetime.snapshotGeneration!;

  // Reopen: a fresh session object restarts the counter with a NEW seed.
  const secondLifetime = makeSession();
  setSessionSnapshot(secondLifetime, makeSnapshot());

  // Probabilistic, not identity-based: the seeds collide with ~1/900000
  // probability (an accepted residual risk, documented on the field).
  expect(secondLifetime.snapshotGeneration).not.toBe(oldGeneration);
  // A pin minted in the previous lifetime warns instead of reading as current.
  expect(
    resolveRefStalenessWarning({
      session: secondLifetime,
      ref: '@e1',
      mintedGeneration: oldGeneration,
    }),
  ).toContain(`minted from snapshot s${oldGeneration}`);
});

test('resolveRefStalenessWarning: frame expiry is checked before the epoch (ADR 0014 evidence #17)', () => {
  const session = makeSession();
  session.snapshotGeneration = 15;
  activateCompleteRefFrame(session);

  // Expired frame: ANY read is stale, even a pin matching the epoch — a matching
  // pin proves identity within the retained frame, not that the UI is current.
  expireRefFrame(session);
  expect(resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: 15 })).toBe(
    STALE_SNAPSHOT_REFS_WARNING,
  );
  expect(resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: undefined })).toBe(
    STALE_SNAPSHOT_REFS_WARNING,
  );

  // Active frame: a pin matching the epoch and a plain ref are both clean; a pin
  // from another epoch gets the precise generation warning.
  activateCompleteRefFrame(session);
  expect(
    resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: 15 }),
  ).toBeUndefined();
  expect(
    resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: undefined }),
  ).toBeUndefined();
  expect(resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: 12 })).toBe(
    "Ref @e37 was minted from snapshot s12 but the session's ref frame is now s15 — re-run snapshot -i.",
  );
});

test('resolveRefStalenessWarning names the frozen frame epoch, not the bumped observation generation (ADR 0014)', () => {
  const session = makeSession();
  // A frame was issued at generation 15.
  session.snapshotGeneration = 15;
  activateCompleteRefFrame(session);

  // A read-only capture replaces the observation and advances the observation
  // counter WITHOUT re-issuing the frame — the frame epoch stays frozen at 15.
  setSessionSnapshot(session, makeSnapshot());
  expect(session.snapshotGeneration).toBe(16);
  expect(refFrame(session).generation).toBe(15);

  // A pin matching the FROZEN frame epoch is clean, even though the observation
  // generation has since advanced past it.
  expect(
    resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: 15 }),
  ).toBeUndefined();

  // A pin from another epoch names the frame epoch (s15), never the bumped
  // observation generation (s16).
  expect(resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: 12 })).toBe(
    "Ref @e37 was minted from snapshot s12 but the session's ref frame is now s15 — re-run snapshot -i.",
  );
});

test('resolveRefStalenessWarning treats a missing stored generation as s0', () => {
  const session = makeSession();
  expect(resolveRefStalenessWarning({ session, ref: 'e2', mintedGeneration: 3 })).toBe(
    "Ref @e2 was minted from snapshot s3 but the session's ref frame is now s0 — re-run snapshot -i.",
  );
  expect(resolveRefStalenessWarning({ session, ref: '@e2', mintedGeneration: 0 })).toBeUndefined();
});

test('markSessionPartialRefsIssued: an empty result leaves all frame state untouched (ADR 0014)', () => {
  const session = makeSession();
  // A useful prior frame exists.
  session.snapshotGeneration = 7;
  activatePartialRefFrame(session, new Set(['e1']));
  const priorFrame = refFrame(session);

  // An empty partial publication (no refs) must not supersede that authority.
  markSessionPartialRefsIssued(session, []);
  // The frame is one value, so "untouched" is one identity check rather than a
  // field-by-field comparison that can miss the field nobody thought to assert.
  expect(refFrame(session)).toBe(priorFrame);
  expect(refFrameState(session)).toBe('active');
  expect(refFrameScope(session)).toEqual(new Set(['e1']));
  expect(refFrame(session).generation).toBe(7);

  // A non-empty result supersedes with exactly its bodies.
  session.snapshotGeneration = 9;
  markSessionPartialRefsIssued(session, ['@e5~s7', 'e6']);
  expect(refFrameScope(session)).toEqual(new Set(['e5', 'e6']));
  expect(refFrame(session).generation).toBe(9);
});

// The observation counter and the authorization epoch are different clocks, and conflating them
// is a documented mistake in this file's history: a comment in snapshot-runtime.ts asserted that
// a diff leaves refs pinned to the previous generation "which is exactly what the pinned warning
// diagnoses". Hardware verification against that claim found the opposite, because it IS the
// opposite — `resolveRefStalenessWarning` compares the pin to the frame epoch on purpose. This
// test states the real contract so the claim cannot drift back into a comment.
test('a ref pinned before a diff keeps resolving: the diff advances the counter, not the epoch', () => {
  const session = makeSession();

  // `snapshot` stores a tree and issues a complete frame, so the epoch is the counter.
  setSessionSnapshot(session, makeSnapshot());
  activateCompleteRefFrame(session);
  const issuedAt = refFrameEpoch(session);
  expect(issuedAt).toBe(session.snapshotGeneration);

  // `diff` replaces the stored tree, so lineage advances the counter — but it passes
  // `issuesRefsToClient: false`, so it never reactivates the frame.
  const afterDiff: SessionState = { ...session };
  setSnapshotLineage(afterDiff, {
    scopeSource: undefined,
    keptCurrentSnapshot: false,
    previousGeneration: session.snapshotGeneration,
  });
  expect(afterDiff.snapshotGeneration).not.toBe(session.snapshotGeneration);
  expect(refFrameEpoch(afterDiff)).toBe(issuedAt);

  // So the pin minted by the snapshot is still authorized: no warning.
  expect(
    resolveRefStalenessWarning({
      session: afterDiff,
      ref: `@e1~s${issuedAt}`,
      mintedGeneration: issuedAt,
    }),
  ).toBeUndefined();

  // A pin from a DIFFERENT frame is what the warning is for.
  expect(
    resolveRefStalenessWarning({
      session: afterDiff,
      ref: '@e1~s1',
      mintedGeneration: 1,
    }),
  ).toBeDefined();
});

test('keeping the current snapshot leaves the counter alone', () => {
  const session = makeSession();
  setSessionSnapshot(session, makeSnapshot());
  const before = session.snapshotGeneration;

  setSnapshotLineage(session, {
    scopeSource: undefined,
    keptCurrentSnapshot: true,
    previousGeneration: before,
  });
  expect(session.snapshotGeneration).toBe(before);
});
