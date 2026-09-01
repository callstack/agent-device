import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { SessionState } from '../../../types.ts';
import { admitRefMutation, refFrameScope } from '../../../ref-frame.ts';
import { markSessionPartialRefsIssued } from '../../../session-snapshot.ts';
import { publishInteractionAmbiguityCandidates } from '../interaction-ambiguity-publication.ts';

function session(): SessionState {
  return {
    name: 'ambiguity-test',
    device: {
      platform: 'apple',
      target: 'mobile',
      kind: 'simulator',
      id: 'sim',
      name: 'iPhone',
    },
    createdAt: 0,
    actions: [],
    snapshotGeneration: 42,
    snapshot: { nodes: [], createdAt: 0, backend: 'xctest' },
  };
}

test('ambiguous mutation errors issue a bounded partial ref frame', () => {
  const state = session();
  const published = publishInteractionAmbiguityCandidates({
    error: new AppError('AMBIGUOUS_MATCH', 'Selector matched 4 elements', {
      matches: 4,
      candidates: ['@e2 [text] "Team Standup"', '@e5 [button] "Team Standup"'],
    }),
    snapshotGeneration: state.snapshotGeneration,
    publishPartialRefs: (refs) => markSessionPartialRefsIssued(state, refs),
  });

  assert.equal(published.details?.refsGeneration, 42);
  assert.deepEqual(refFrameScope(state), new Set(['e2', 'e5']));
  assert.deepEqual(admitRefMutation({ session: state, refBody: 'e5', mintedGeneration: 42 }), {
    admitted: true,
  });
  assert.equal(
    admitRefMutation({ session: state, refBody: 'e4', mintedGeneration: 42 }).admitted,
    false,
  );
});

test('non-ambiguity errors do not change ref authority', () => {
  const state = session();
  const original = new AppError('COMMAND_FAILED', 'tap failed');

  assert.equal(
    publishInteractionAmbiguityCandidates({
      error: original,
      snapshotGeneration: state.snapshotGeneration,
      publishPartialRefs: (refs) => markSessionPartialRefsIssued(state, refs),
    }),
    original,
  );
  assert.equal(state.refFrameScope, undefined);
});
