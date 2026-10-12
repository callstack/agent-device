import { expect, test } from 'vitest';
import { makeSessionStore } from './support/store-factory.ts';
import type { SettleObservation } from '@agent-device/contracts/interaction';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { SessionState } from '../session-state.ts';
import {
  markSessionPartialRefsIssued,
  issueSettleRefs,
  publishAmbiguousMatchCandidateRefs,
  resolveRefStalenessWarning,
  setSessionSnapshot,
  setCommandSnapshot,
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
  const diffSnapshot = makeSnapshot();
  setCommandSnapshot(afterDiff, {
    snapshot: diffSnapshot,
    scopeSource: undefined,
    keptCurrentSnapshot: false,
    previousGeneration: session.snapshotGeneration,
  });
  expect(afterDiff.snapshot).toBe(diffSnapshot);
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

  setCommandSnapshot(session, {
    snapshot: session.snapshot!,
    scopeSource: undefined,
    keptCurrentSnapshot: true,
    previousGeneration: before,
  });
  expect(session.snapshotGeneration).toBe(before);
});

for (const retire of [false, true]) {
  test(`settle ref issuance checks lifetime before publishing (${retire ? 'retired' : 'live'})`, () => {
    const store = makeSessionStore();
    const session = makeSession();
    setSessionSnapshot(session, makeSnapshot());
    const ref = store.publish('cwd:settle:default', session);
    const priorFrame = refFrame(session);
    if (retire) {
      store.retire(ref);
      store.publish(ref.address, session);
    }
    const observation: SettleObservation = {
      settled: true,
      waitedMs: 1,
      captures: 2,
      quietMs: 1,
      timeoutMs: 20,
      diff: {
        summary: { additions: 1, removals: 0, unchanged: 0 },
        lines: [{ kind: 'added', text: 'new button', ref: 'e1' }],
      },
    };
    const generation = issueSettleRefs(ref, store, observation);
    if (retire) {
      expect(generation).toBeUndefined();
      expect(refFrame(session)).toBe(priorFrame);
    } else {
      expect(generation).toBe(session.snapshotGeneration);
      expect(refFrameScope(session)).toEqual(new Set(['e1']));
    }
  });
}

// #2870 review: every response that prints candidate @refs must issue those
// refs on the frame they came from, and issuance is only valid against the
// tree that generation describes. One rule, consumed by the acting refusal
// (touch runtime) and the strict-read refusals (is / get attrs dispatch).
test('ambiguous refusals issue their printed candidates as a partial frame', () => {
  const store = makeSessionStore();
  const session = makeSession();
  const captured = makeSnapshot();
  setSessionSnapshot(session, captured);
  const ref = store.publish('cwd:ambiguity:default', session);
  const published = publishAmbiguousMatchCandidateRefs(
    ref,
    store,
    new AppError('AMBIGUOUS_MATCH', 'Selector matched 4 elements', {
      matches: 4,
      candidates: ['@e2 [text] "Team Standup"', '@e5 [button] "Team Standup"'],
    }),
    // The consumed capture IS the stored tree: what the capture runtime does
    // for every non-sparse read, node identity included.
    captured,
  );
  expect(published.details?.refsGeneration).toBe(session.snapshotGeneration);
  expect(refFrameScope(session)).toEqual(new Set(['e2', 'e5']));
});

/**
 * The P1 the review caught: the capture runtime DELIBERATELY does not store a
 * sparse-quality capture (`updateSessionSnapshot` skips it, and `issueSettleRefs`
 * documents the same ruling for the settle path), so candidates minted from
 * that tree cannot be issued against the PREVIOUS stored tree's generation —
 * a printed @ref would resolve to a different node. Printing and issuing are
 * one decision: no stored tree, no printed candidates, and the hint drops the
 * "act on a printed candidate" route it could not honor.
 */
test('a sparse capture that was never stored issues nothing and prints no candidates', () => {
  const store = makeSessionStore();
  const session = makeSession();
  setSessionSnapshot(session, makeSnapshot());
  const ref = store.publish('cwd:ambiguity-sparse:default', session);
  const storedNodes = session.snapshot!.nodes;
  // The sparse capture the failing request consumed: a different tree, never
  // stored (that skip is the capture runtime's deliberate quality ruling).
  const sparseCapture: SnapshotState = {
    nodes: [],
    createdAt: Date.now(),
    backend: 'xctest',
    snapshotQuality: { state: 'sparse', backend: 'tree', reasonCode: 'sparse-tree' },
  };
  const published = publishAmbiguousMatchCandidateRefs(
    ref,
    store,
    new AppError('AMBIGUOUS_MATCH', 'Selector matched 2 elements', {
      matches: 2,
      candidates: ['@e2 [text] "a"', '@e3 [text] "b"'],
      hint: 'Narrow the selector with role/id/longer text, or act on a printed candidate with a command that takes refs, such as press.',
    }),
    sparseCapture,
  );
  expect(published.code).toBe('AMBIGUOUS_MATCH');
  expect(published.details?.refsGeneration).toBeUndefined();
  expect(published.details?.candidates).toBeUndefined();
  // The truthful count survives; the unusable affordance does not.
  expect(published.details?.matches).toBe(2);
  expect(String(published.details?.hint)).not.toMatch(/printed candidate/);
  // Nothing was issued: the frame stays untouched and the stored tree was
  // never replaced by the sparse capture.
  expect(session.refFrame).toBeUndefined();
  expect(session.snapshot!.nodes).toBe(storedNodes);
});

test('a non-ambiguity read refusal issues nothing', () => {
  const store = makeSessionStore();
  const session = makeSession();
  const captured = makeSnapshot();
  setSessionSnapshot(session, captured);
  const ref = store.publish('cwd:ambiguity-none:default', session);
  const original = new AppError('COMMAND_FAILED', 'Selector did not match: label="X"');
  const returned = publishAmbiguousMatchCandidateRefs(ref, store, original, captured);
  expect(returned).toBe(original);
  // The ref-frame accessor defaults a never-issued frame to PRISTINE; the
  // raw slot staying unset is what "untouched" means here.
  expect(session.refFrame).toBeUndefined();
});

test('ambiguity on a retired session ref issues nothing and prints no candidates', () => {
  const store = makeSessionStore();
  const session = makeSession();
  const captured = makeSnapshot();
  setSessionSnapshot(session, captured);
  const ref = store.publish('cwd:ambiguity-retired:default', session);
  store.retire(ref);
  const published = publishAmbiguousMatchCandidateRefs(
    ref,
    store,
    new AppError('AMBIGUOUS_MATCH', 'Selector matched 2 elements', {
      matches: 2,
      candidates: ['@e2 [text] "a"', '@e3 [text] "b"'],
    }),
    captured,
  );
  expect(published.details?.refsGeneration).toBeUndefined();
  expect(published.details?.candidates).toBeUndefined();
  expect(published.details?.matches).toBe(2);
  expect(session.refFrame).toBeUndefined();
});

/**
 * The sessionless shape `is` can travel (a selector route whose `lookup` found
 * no live ref): with no session there is no generation to freeze and no frame
 * to authorize, so the refusal must degrade to the count-only form too rather
 * than print refs nobody can act on.
 */
test('ambiguity without a session ref (sessionless route) issues nothing and prints no candidates', () => {
  const store = makeSessionStore();
  const published = publishAmbiguousMatchCandidateRefs(
    undefined,
    store,
    new AppError('AMBIGUOUS_MATCH', 'Selector matched 2 elements', {
      matches: 2,
      candidates: ['@e2 [text] "a"', '@e3 [text] "b"'],
    }),
    makeSnapshot(),
  );
  expect(published.code).toBe('AMBIGUOUS_MATCH');
  expect(published.details?.refsGeneration).toBeUndefined();
  expect(published.details?.candidates).toBeUndefined();
  expect(published.details?.matches).toBe(2);
});

/**
 * A session whose lifetime never stored a tree has no generation to freeze
 * (both `setSessionSnapshot` and every capture runtime mint it on the first
 * store). Same rule as the sparse case: nothing issuable, nothing printable.
 */
test('ambiguity on a session with no stored snapshot issues nothing and prints no candidates', () => {
  const store = makeSessionStore();
  const session = makeSession();
  const ref = store.publish('cwd:ambiguity-nogen:default', session);
  const published = publishAmbiguousMatchCandidateRefs(
    ref,
    store,
    new AppError('AMBIGUOUS_MATCH', 'Selector matched 2 elements', {
      matches: 2,
      candidates: ['@e2 [text] "a"', '@e3 [text] "b"'],
    }),
    makeSnapshot(),
  );
  expect(published.details?.refsGeneration).toBeUndefined();
  expect(published.details?.candidates).toBeUndefined();
  expect(published.details?.matches).toBe(2);
  expect(session.refFrame).toBeUndefined();
});
