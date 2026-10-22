import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  coversTarget,
  resolveRunRef,
  selectNightlyBaseline,
  selectRange,
  type WorkflowRun,
} from './nightly-artifacts.ts';
import { summaryFixture } from './summary.fixtures.ts';

const run = (id: string, createdAt: string, event = 'schedule'): WorkflowRun => ({
  id,
  createdAt,
  headSha: `sha-${id}`,
  event,
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

const baselineIds = (
  runs: Iterable<WorkflowRun>,
  options: { nights?: number; exclude?: string[]; reject?: string[] } = {},
) =>
  selectNightlyBaseline(
    runs,
    {
      before: '2026-10-20T03:00:00Z',
      exclude: new Set(options.exclude),
      nights: options.nights ?? 3,
    },
    (r) => (options.reject?.includes(r.id) ? undefined : r.id),
  ).map(({ value }) => value);

test('a rolling baseline takes one scheduled run per UTC night and skips dispatches', () => {
  const newestFirst = [
    run('20', '2026-10-19T16:00:00Z', 'workflow_dispatch'),
    run('19', '2026-10-19T15:00:00Z', 'workflow_dispatch'),
    run('18', '2026-10-19T14:00:00Z', 'workflow_dispatch'),
    run('17', '2026-10-19T02:50:00Z'),
    run('16', '2026-10-19T02:40:00Z'),
    run('15', '2026-10-18T02:40:00Z'),
    run('14', '2026-10-17T02:40:00Z'),
  ];
  // Three dispatches in one afternoon are not three nights; 2026-10-19 counts its newest run once.
  assert.deepEqual(baselineIds(newestFirst), ['17', '15', '14']);
});

test('a night without a usable summary gives way to an older scheduled run of that night', () => {
  const newestFirst = [
    run('17', '2026-10-19T02:50:00Z'),
    run('16', '2026-10-19T02:40:00Z'),
    run('15', '2026-10-18T02:40:00Z'),
    run('14', '2026-10-17T02:40:00Z'),
  ];
  assert.deepEqual(baselineIds(newestFirst, { reject: ['17'], exclude: ['15'] }), ['16', '14']);
});

test('a rolling baseline reads past 100 runs and stops once it has enough nights', () => {
  function* history(): Generator<WorkflowRun> {
    for (let i = 0; i < 150; i++) {
      yield run(`d${i}`, '2026-10-19T12:00:00Z', 'workflow_dispatch');
    }
    yield run('n3', '2026-10-18T02:40:00Z');
    yield run('n2', '2026-10-17T02:40:00Z');
    yield run('n1', '2026-10-16T02:40:00Z');
    throw new Error('read past the last needed night');
  }
  assert.deepEqual(baselineIds(history()), ['n3', 'n2', 'n1']);
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
