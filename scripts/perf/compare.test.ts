import assert from 'node:assert/strict';
import { test } from 'vitest';
import { compareRuns, type ComparisonRow } from './compare.ts';
import { summaryFixture, type StepFixture } from './summary-fixture.ts';

const STEP = 'heavy-feed/snapshot';

function nights(...steps: StepFixture[][]) {
  return steps.map((night, index) => ({ summary: summaryFixture(night), label: `night ${index}` }));
}

function row(target: StepFixture[], baseline: StepFixture[][], id = STEP): ComparisonRow {
  const comparison = compareRuns(
    { summary: summaryFixture(target), label: 'tonight' },
    nights(...baseline),
  );
  return comparison.rows.find((r) => r.id === id)!;
}

const flat = (ms: number, extra: Partial<StepFixture> = {}): StepFixture[] => [
  { id: STEP, daemonMs: [ms, ms, ms], ...extra },
];

test('flags a slowdown that exceeds a quiet baseline and the relative floor', () => {
  const result = row(
    [{ id: STEP, daemonMs: [1450, 1500, 1550] }],
    [flat(1000), flat(1010), flat(990)],
  );
  assert.equal(result.verdict, 'regression');
  assert.equal(result.metric, 'daemon');
  assert.equal(result.baseline?.median, 1000);
  assert.equal(result.deltaMs, 500);
  assert.equal(result.threshold, 0.2);
});

test('does not flag the same slowdown when nightly medians already swing that much', () => {
  const result = row(
    [{ id: STEP, daemonMs: [1450, 1500, 1550] }],
    [flat(500), flat(1000), flat(1500), flat(700), flat(1300)],
  );
  assert.equal(result.verdict, 'unchanged');
  // 3 × scaled MAD: deviations from 1000 are 0, 300, 300, 500, 500.
  assert.ok(Math.abs(result.threshold! - (3 * 1.4826 * 300) / 1000) < 1e-9);
});

test('does not flag a large relative change below the absolute floor', () => {
  assert.equal(row(flat(60), [flat(40), flat(40), flat(40)]).verdict, 'unchanged');
});

test('flags a speedup beyond noise as an improvement', () => {
  assert.equal(row(flat(500), [flat(1000), flat(1010), flat(990)]).verdict, 'improvement');
});

test('withholds a timing verdict until enough nights exist', () => {
  const result = row(flat(1500), [flat(1000), flat(1000)]);
  assert.equal(result.verdict, 'insufficient-baseline');
  assert.equal(result.deltaRelative, 0.5);
});

test('reports failures that no baseline night had, and failures that went away', () => {
  const clean = [flat(1000), flat(1000), flat(1000)];
  assert.equal(row(flat(1000, { failures: 1 }), clean).verdict, 'new-failures');
  const failing = [
    flat(1000, { failures: 1 }),
    flat(1000, { failures: 2 }),
    flat(1000, { failures: 1 }),
  ];
  assert.equal(row(flat(1000), failing).verdict, 'fixed');
  // A step that already failed on some baseline night is judged on timing instead.
  const flaky = [flat(1000, { failures: 1 }), flat(1000), flat(1000)];
  assert.equal(row(flat(1000, { failures: 1 }), flaky).verdict, 'unchanged');
});

test('falls back to wall time when any run lacks the daemon timer', () => {
  const result = row(flat(1000), [
    flat(1000),
    [{ id: STEP, wallMs: [1300, 1300, 1300] }],
    flat(1000),
  ]);
  assert.equal(result.metric, 'wall');
});

test('marks steps that only one side measured', () => {
  const comparison = compareRuns(
    { summary: summaryFixture([{ id: 'a/new', daemonMs: [1] }]), label: 't' },
    [{ summary: summaryFixture([{ id: 'a/old', daemonMs: [1] }]), label: 'b' }],
  );
  assert.deepEqual(
    comparison.rows.map((r) => [r.id, r.verdict]),
    [
      ['a/new', 'new'],
      ['a/old', 'missing'],
    ],
  );
});

test('warns when the baseline ran on another toolchain', () => {
  const comparison = compareRuns(
    { summary: summaryFixture(flat(1000), { xcode: 'Xcode 26.3' }), label: 't' },
    [{ summary: summaryFixture(flat(1000)), label: 'b' }],
  );
  assert.equal(comparison.warnings.length, 1);
  assert.match(comparison.warnings[0]!, /xcode/);
});
