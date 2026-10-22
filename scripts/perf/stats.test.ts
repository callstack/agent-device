import assert from 'node:assert/strict';
import { test } from 'vitest';
import { scaledMad, summarize } from './stats.ts';

test('summarize reports sample spread, the middle median, and nearest-rank p95', () => {
  const stat = summarize([40, 10, 30, 20, Number.NaN])!;
  assert.equal(stat.n, 4);
  assert.equal(stat.mean, 25);
  // Sample (n − 1) deviation: sqrt((15² + 5² + 5² + 15²) / 3).
  assert.ok(Math.abs(stat.stddev - Math.sqrt(500 / 3)) < 1e-9);
  assert.ok(Math.abs(stat.cv - Math.sqrt(500 / 3) / 25) < 1e-9);
  assert.deepEqual([stat.min, stat.median, stat.p95, stat.max], [10, 25, 40, 40]);
});

test('summarize gives a single sample zero spread and no samples no summary', () => {
  assert.deepEqual(summarize([7]), {
    n: 1,
    mean: 7,
    stddev: 0,
    cv: 0,
    median: 7,
    min: 7,
    max: 7,
    p95: 7,
  });
  assert.equal(summarize([]), null);
  assert.equal(summarize([0, 0])?.cv, 0);
});

test('scaledMad ignores one outlying night', () => {
  // Deviations from the median 101 are 49, 1, 1, 3; their median is 2.
  assert.ok(Math.abs(scaledMad([150, 100, 98, 102]) - 1.4826 * 2) < 1e-9);
});
