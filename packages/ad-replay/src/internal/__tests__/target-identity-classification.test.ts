import { test } from 'vitest';
import assert from 'node:assert/strict';
import { classifyTargetBindingMatch } from '../target-identity.ts';

// Decision 3's replay-time verification paths 2-6 are shared with the
// writer's record-time self-check and stay isolated from parser coverage.

test('classifyTargetBindingMatch path 2: matchCount 0 is unverifiable (selector-miss)', () => {
  const result = classifyTargetBindingMatch({
    winnerRef: 'e1',
    matchedRefs: [],
    identitySetRefs: [],
    siblingMatchRefs: [],
    regionMemberRefs: undefined,
    viewportCandidateRef: undefined,
  });
  assert.deepEqual(result, { path: 2, outcome: 'unverifiable', reason: 'selector-miss' });
});

test('classifyTargetBindingMatch path 3: empty identity set is unverifiable', () => {
  const result = classifyTargetBindingMatch({
    winnerRef: 'e1',
    matchedRefs: ['e1'],
    identitySetRefs: [],
    siblingMatchRefs: [],
    regionMemberRefs: undefined,
    viewportCandidateRef: undefined,
  });
  assert.deepEqual(result, { path: 3, outcome: 'unverifiable', reason: 'identity-set-empty' });
});

test('classifyTargetBindingMatch path 4: unique identity-set member equal to winner is verified', () => {
  const result = classifyTargetBindingMatch({
    winnerRef: 'e1',
    matchedRefs: ['e1'],
    identitySetRefs: ['e1'],
    siblingMatchRefs: ['e1'],
    regionMemberRefs: undefined,
    viewportCandidateRef: undefined,
  });
  assert.deepEqual(result, { path: 4, outcome: 'verified' });
});

test('classifyTargetBindingMatch path 5: unique identity-set member that is not the winner is unverifiable', () => {
  const result = classifyTargetBindingMatch({
    winnerRef: 'e1',
    matchedRefs: ['e1'],
    identitySetRefs: ['e9'],
    siblingMatchRefs: [],
    regionMemberRefs: undefined,
    viewportCandidateRef: undefined,
  });
  assert.deepEqual(result, { path: 5, outcome: 'unverifiable', reason: 'unique-but-wrong' });
});

test('classifyTargetBindingMatch path 6: duplicate identity resolved by a unique sibling match', () => {
  const result = classifyTargetBindingMatch({
    winnerRef: 'e1',
    matchedRefs: ['e1', 'e2'],
    identitySetRefs: ['e1', 'e2'],
    siblingMatchRefs: ['e1'],
    regionMemberRefs: undefined,
    viewportCandidateRef: undefined,
  });
  assert.deepEqual(result, { path: 6, outcome: 'verified' });
});

test('classifyTargetBindingMatch path 6: viewport order resolves repeated sibling ordinals', () => {
  const result = classifyTargetBindingMatch({
    winnerRef: 'e1',
    matchedRefs: ['e1', 'e2'],
    identitySetRefs: ['e1', 'e2'],
    siblingMatchRefs: ['e1', 'e2'],
    regionMemberRefs: ['e2', 'e1'],
    viewportCandidateRef: 'e1',
  });
  assert.deepEqual(result, { path: 6, outcome: 'verified' });
});

test('classifyTargetBindingMatch path 6: unavailable or out-of-range viewport evidence falls through', () => {
  for (const [regionMemberRefs, viewportCandidateRef] of [
    [undefined, undefined],
    [['e1', 'e2'], undefined],
  ] as const) {
    const result = classifyTargetBindingMatch({
      winnerRef: 'e1',
      matchedRefs: ['e1', 'e2'],
      identitySetRefs: ['e1', 'e2'],
      siblingMatchRefs: ['e1', 'e2'],
      regionMemberRefs,
      viewportCandidateRef,
    });
    assert.deepEqual(result, { path: 6, outcome: 'unverifiable', reason: 'no-signal-isolation' });
  }
});

test('classifyTargetBindingMatch path 6: a signal isolating a different node than the winner is distinct from fall-through', () => {
  for (const params of [
    { siblingMatchRefs: ['e1', 'e2'], regionMemberRefs: ['e1', 'e2'], viewportCandidateRef: 'e2' },
    { siblingMatchRefs: ['e2'], regionMemberRefs: ['e1', 'e2'], viewportCandidateRef: 'e1' },
  ]) {
    const result = classifyTargetBindingMatch({
      winnerRef: 'e1',
      matchedRefs: ['e1', 'e2'],
      identitySetRefs: ['e1', 'e2'],
      ...params,
    });
    assert.deepEqual(result, { path: 6, outcome: 'unverifiable', reason: 'signal-isolated-wrong' });
  }
});
