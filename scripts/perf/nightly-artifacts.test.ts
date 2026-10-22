import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  baselineCandidates,
  coversTarget,
  resolveRunRef,
  selectRange,
  type WorkflowRun,
} from './nightly-artifacts.ts';
import { summaryFixture } from './summary-fixture.ts';

const run = (id: string, createdAt: string): WorkflowRun => ({
  id,
  createdAt,
  headSha: `sha-${id}`,
  event: 'schedule',
});

// Deliberately unsorted, with two runs on 2026-10-19.
const RUNS = [
  run('101', '2026-10-17T03:00:00Z'),
  run('104', '2026-10-20T03:00:00Z'),
  run('102', '2026-10-19T03:00:00Z'),
  run('103', '2026-10-19T15:30:00Z'),
];

test('resolves latest, run ids, and dates to the newest matching run', () => {
  assert.equal(resolveRunRef('latest', RUNS)?.id, '104');
  assert.equal(resolveRunRef('102', RUNS)?.id, '102');
  assert.equal(resolveRunRef('2026-10-19', RUNS)?.id, '103');
  assert.equal(resolveRunRef('2026-10-18', RUNS), undefined);
  assert.throws(() => resolveRunRef('yesterday', RUNS), /Unknown run reference/);
});

test('baseline candidates are earlier runs, newest first, without excluded runs', () => {
  const candidates = baselineCandidates(RUNS, '2026-10-20T03:00:00Z', new Set(['103']));
  assert.deepEqual(
    candidates.map((r) => r.id),
    ['102', '101'],
  );
});

test('a range includes both ends whichever order they are given in', () => {
  const ids = (from: string, to: string) => selectRange(RUNS, from, to).map((r) => r.id);
  assert.deepEqual(ids('101', '102'), ['102', '101']);
  assert.deepEqual(ids('102', '101'), ['102', '101']);
});

test('a date end of a range covers its whole UTC day', () => {
  // 2026-10-19 has a 03:00 run and a later 15:30 run; both belong to the range.
  assert.deepEqual(
    selectRange(RUNS, '2026-10-17', '2026-10-19').map((r) => r.id),
    ['103', '102', '101'],
  );
  assert.deepEqual(
    selectRange(RUNS, '2026-10-19', '104').map((r) => r.id),
    ['104', '103', '102'],
  );
});

test('a rolling baseline accepts only runs that measured every target scenario', () => {
  const full = summaryFixture([
    { id: 'a/x', daemonMs: [1] },
    { id: 'b/y', daemonMs: [1] },
  ]);
  const partial = summaryFixture([{ id: 'b/y', daemonMs: [1] }]);
  assert.equal(coversTarget(full, full), true);
  assert.equal(coversTarget(partial, full), false);
  assert.equal(coversTarget(full, partial), true);
});
