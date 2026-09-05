import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  activateCompleteRefFrame,
  activatePartialRefFrame,
  admitRefMutation,
  expireRefFrame,
  refFrame,
  refFrameEpoch,
  refFrameScope,
  refFrameState,
  type RefFrameAdmission,
} from '../ref-frame.ts';
import type { SessionState } from '../types.ts';

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    name: 'ref-frame-test',
    device: { platform: 'ios', kind: 'simulator', id: 'sim', name: 'iPhone' },
    createdAt: 0,
    ...overrides,
  } as SessionState;
}

function reason(admission: RefFrameAdmission): string | undefined {
  return admission.admitted ? undefined : admission.reason;
}

/**
 * A partial frame can only be reached through its transition: the frame value is
 * constructible only inside `ref-frame.ts`, so a test cannot seed one by hand.
 */
function partialSession(generation: number, scope: ReadonlySet<string>): SessionState {
  const state = session({ snapshotGeneration: generation });
  activatePartialRefFrame(state, scope);
  return state;
}

test('defaults: a session with no frame reads as active / all / undefined epoch', () => {
  const s = session();
  assert.equal(s.refFrame, undefined);
  assert.equal(refFrameState(s), 'active');
  assert.equal(refFrameScope(s), 'all');
  assert.equal(refFrameEpoch(s), undefined);
});

test('complete active frame admits a plain ref', () => {
  const s = session({ snapshotGeneration: 42 });
  assert.deepEqual(admitRefMutation({ session: s, refBody: 'e1', mintedGeneration: undefined }), {
    admitted: true,
  });
});

test('complete active frame admits a pinned ref at the current epoch', () => {
  const s = session({ snapshotGeneration: 42 });
  assert.deepEqual(admitRefMutation({ session: s, refBody: 'e1', mintedGeneration: 42 }), {
    admitted: true,
  });
});

test('a pinned ref at another epoch is a generation mismatch', () => {
  const s = session({ snapshotGeneration: 43 });
  assert.equal(
    reason(admitRefMutation({ session: s, refBody: 'e1', mintedGeneration: 42 })),
    'ref_generation_mismatch',
  );
});

test('an expired frame rejects every ref, and expiry wins over a matching pin', () => {
  const s = session({ snapshotGeneration: 42 });
  expireRefFrame(s);
  assert.equal(
    reason(admitRefMutation({ session: s, refBody: 'e1', mintedGeneration: undefined })),
    'ref_frame_expired',
  );
  assert.equal(
    reason(admitRefMutation({ session: s, refBody: 'e1', mintedGeneration: 42 })),
    'ref_frame_expired',
  );
});

test('a partial frame rejects a plain ref: it requires a complete frame', () => {
  const s = partialSession(42, new Set(['e1']));
  assert.equal(
    reason(admitRefMutation({ session: s, refBody: 'e1', mintedGeneration: undefined })),
    'plain_ref_requires_complete_frame',
  );
});

test('a partial frame admits only pinned refs it issued, at the current epoch', () => {
  const s = partialSession(42, new Set(['e1']));
  assert.deepEqual(admitRefMutation({ session: s, refBody: 'e1', mintedGeneration: 42 }), {
    admitted: true,
  });
  assert.equal(
    reason(admitRefMutation({ session: s, refBody: 'e2', mintedGeneration: 42 })),
    'ref_not_issued',
  );
});

test('generation mismatch is evaluated before issuance scope', () => {
  // A pin at the wrong epoch is a mismatch even if the body was in scope.
  const s = partialSession(43, new Set(['e1']));
  assert.equal(
    reason(admitRefMutation({ session: s, refBody: 'e1', mintedGeneration: 42 })),
    'ref_generation_mismatch',
  );
});

test('expireRefFrame is idempotent and rejects all refs while expired', () => {
  const s = session({ snapshotGeneration: 42 });
  expireRefFrame(s);
  assert.equal(refFrameState(s), 'expired');
  const expired = refFrame(s);
  expireRefFrame(s); // idempotent
  assert.equal(refFrameState(s), 'expired');
  // Identity, not shape: lineage holders compare frames with `===`, so a repeat
  // expiry must leave the same frame rather than an equal one.
  assert.equal(refFrame(s), expired);
  assert.equal(
    reason(admitRefMutation({ session: s, refBody: 'e1', mintedGeneration: 42 })),
    'ref_frame_expired',
  );
});

test('activateCompleteRefFrame re-authorizes a complete frame after expiry', () => {
  const s = partialSession(42, new Set(['e1']));
  expireRefFrame(s);
  activateCompleteRefFrame(s);
  assert.equal(refFrameState(s), 'active');
  assert.equal(refFrameScope(s), 'all');
  assert.deepEqual(admitRefMutation({ session: s, refBody: 'e9', mintedGeneration: undefined }), {
    admitted: true,
  });
});

test('expireRefFrame clears scoped-snapshot lineage at the seam (ADR 0014)', () => {
  const scopeTree = {
    nodes: [],
    createdAt: 0,
    backend: 'xctest',
  } as unknown as SessionState['snapshot'];
  const s = session({ snapshotGeneration: 42, snapshotScopeSource: scopeTree });
  expireRefFrame(s);
  // A mutation breaks the consecutive `snapshot -s @ref` chain, so a later
  // repeated scoped snapshot cannot borrow stale lineage across the side effect.
  assert.equal(s.snapshotScopeSource, undefined);
});
