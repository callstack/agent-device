import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  admitRefMutation,
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

test('defaults: no frame fields set reads as active / all / undefined epoch', () => {
  const s = session();
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
  const s = session({ snapshotGeneration: 42, refFrameState: 'expired' });
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
  const s = session({ snapshotGeneration: 42, refFrameScope: new Set(['e1']) });
  assert.equal(
    reason(admitRefMutation({ session: s, refBody: 'e1', mintedGeneration: undefined })),
    'plain_ref_requires_complete_frame',
  );
});

test('a partial frame admits only pinned refs it issued, at the current epoch', () => {
  const s = session({ snapshotGeneration: 42, refFrameScope: new Set(['e1']) });
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
  const s = session({ snapshotGeneration: 43, refFrameScope: new Set(['e1']) });
  assert.equal(
    reason(admitRefMutation({ session: s, refBody: 'e1', mintedGeneration: 42 })),
    'ref_generation_mismatch',
  );
});
