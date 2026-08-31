import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readElementMatchCandidateRefs, readErrorCandidateViews } from './errors.ts';

test('readElementMatchCandidateRefs extracts refs from candidate lines', () => {
  assert.deepEqual(
    readElementMatchCandidateRefs({
      candidates: ['@e2 [button] "Follow"', '@e5~s42 [button] "Follow"', 'not a ref'],
    }),
    ['e2', 'e5'],
  );
});

test('readElementMatchCandidateRefs ignores non-string candidate details', () => {
  assert.deepEqual(readElementMatchCandidateRefs({ candidates: [{ ref: 'e2' }, 4] }), []);
  assert.deepEqual(readElementMatchCandidateRefs(undefined), []);
});

test('readErrorCandidateViews projects element matches and generation', () => {
  assert.deepEqual(
    readErrorCandidateViews({
      matches: 7,
      candidates: ['@e2 [button] "Row"'],
      refsGeneration: 42,
    }),
    [
      {
        kind: 'element-match',
        matches: 7,
        candidates: ['@e2 [button] "Row"'],
        refsGeneration: 42,
      },
    ],
  );
});

test('readErrorCandidateViews projects devices and rejects object candidates', () => {
  assert.deepEqual(
    readErrorCandidateViews({
      candidates: [{ id: 'SIM-001', name: 'iPhone 17 Pro' }],
      devices: [{ id: 'SIM-001', name: 'iPhone 17 Pro' }],
    }),
    [{ kind: 'device', devices: [{ id: 'SIM-001', name: 'iPhone 17 Pro' }] }],
  );
});
