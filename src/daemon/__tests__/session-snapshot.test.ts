import { expect, test } from 'vitest';
import type { SnapshotState } from '../../kernel/snapshot.ts';
import type { SessionState } from '../types.ts';
import {
  markSessionPartialRefsIssued,
  resolveRefStalenessWarning,
  setSessionSnapshot,
  STALE_SNAPSHOT_REFS_WARNING,
} from '../session-snapshot.ts';

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
  expect(session.refFrameState).toBeUndefined();

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
  session.refFrameGeneration = 15;

  // Expired frame: ANY read is stale, even a pin matching the epoch — a matching
  // pin proves identity within the retained frame, not that the UI is current.
  session.refFrameState = 'expired';
  expect(resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: 15 })).toBe(
    STALE_SNAPSHOT_REFS_WARNING,
  );
  expect(resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: undefined })).toBe(
    STALE_SNAPSHOT_REFS_WARNING,
  );

  // Active frame: a pin matching the epoch and a plain ref are both clean; a pin
  // from another epoch gets the precise generation warning.
  session.refFrameState = 'active';
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
  session.refFrameGeneration = 15;
  session.refFrameState = 'active';

  // A read-only capture replaces the observation and advances the observation
  // counter WITHOUT re-issuing the frame — the frame epoch stays frozen at 15.
  setSessionSnapshot(session, makeSnapshot());
  expect(session.snapshotGeneration).toBe(16);
  expect(session.refFrameGeneration).toBe(15);

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
  session.refFrameState = 'active';
  session.refFrameScope = new Set(['e1']);
  session.refFrameGeneration = 7;

  // An empty partial publication (no refs) must not supersede that authority.
  markSessionPartialRefsIssued(session, []);
  expect(session.refFrameState).toBe('active');
  expect(session.refFrameScope).toEqual(new Set(['e1']));
  expect(session.refFrameGeneration).toBe(7);

  // A non-empty result supersedes with exactly its bodies.
  session.snapshotGeneration = 9;
  markSessionPartialRefsIssued(session, ['@e5~s7', 'e6']);
  expect(session.refFrameScope).toEqual(new Set(['e5', 'e6']));
  expect(session.refFrameGeneration).toBe(9);
});
