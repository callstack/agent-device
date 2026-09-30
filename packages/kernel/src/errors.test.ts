import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  AppError,
  discloseDispatch,
  discloseDispatchAfterSteps,
  normalizeError,
  throwDaemonError,
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

test('normalizeError keeps a producer dispatch disclosure in details and never invents one', () => {
  for (const dispatched of ['no', 'unknown'] as const) {
    const normalized = normalizeError(new AppError('COMMAND_FAILED', 'tap failed', { dispatched }));
    assert.equal(normalized.details?.dispatched, dispatched);
    assert.throws(
      () => throwDaemonError(normalized),
      (error: unknown) => error instanceof AppError && error.details?.dispatched === dispatched,
    );
  }
  const unclassified = normalizeError(new AppError('COMMAND_FAILED', 'tap failed', { x: 1 }));
  assert.equal(unclassified.details?.dispatched, undefined);
  assert.equal('dispatched' in (unclassified.details ?? {}), false);
  assert.equal(normalizeError(new AppError('DEVICE_IN_USE', 'busy')).details, undefined);
});

test('discloseDispatchAfterSteps keeps no only while no step of the series was dispatched', () => {
  const refusal = () => discloseDispatch(new AppError('COMMAND_FAILED', 'busy'), 'no');
  assert.equal((discloseDispatchAfterSteps(refusal(), 0) as AppError).details?.dispatched, 'no');
  const later = discloseDispatchAfterSteps(refusal(), 2) as AppError;
  assert.equal(later.details?.dispatched, 'unknown');
  assert.equal(later.details?.dispatchedSteps, 2);
  const nested = discloseDispatchAfterSteps(
    discloseDispatch(new AppError('COMMAND_FAILED', 'chunk 3 lost'), 'unknown', {
      dispatchedSteps: 2,
    }),
    1,
  ) as AppError;
  assert.equal(nested.details?.dispatchedSteps, 3);
  const plain = new Error('socket closed');
  assert.equal(discloseDispatchAfterSteps(plain, 4), plain);
});
