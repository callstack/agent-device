import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  readElementMatchCandidateRefs,
  readErrorCandidateViews,
  summarizeCommandAttemptFailures,
} from './errors.ts';

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

test("summarizeCommandAttemptFailures joins argv and caps each attempt's stderr", () => {
  const [summary] = summarizeCommandAttemptFailures([
    { args: ['shell', 'cmd', 'fingerprint'], stdout: 'out', stderr: 'x'.repeat(500), exitCode: 2 },
  ]);

  assert.deepEqual(summary, {
    args: 'shell cmd fingerprint',
    exitCode: 2,
    // 400 is the per-attempt budget the settings retry loops have always shipped evidence under;
    // it is pinned as a literal so a changed budget cannot move both the producer and this oracle.
    stderr: 'x'.repeat(400),
  });
});

test('summarizeCommandAttemptFailures keeps every attempt in the order it ran', () => {
  assert.deepEqual(
    summarizeCommandAttemptFailures([
      { args: ['first'], stdout: '', stderr: 'a', exitCode: 1 },
      { args: ['second'], stdout: '', stderr: 'b', exitCode: 9 },
    ]).map(({ args, exitCode }) => `${args}:${exitCode}`),
    ['first:1', 'second:9'],
  );
});
