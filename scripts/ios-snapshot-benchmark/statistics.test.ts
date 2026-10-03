import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildMeasurement, markOutliers, summarize } from './statistics.ts';
import type { RawSample } from './types.ts';

function sample(index: number, wallClockMs: number, ok = true): RawSample {
  return {
    index,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:00.001Z',
    operation: 'snapshot',
    wallClockMs,
    targetGeneration: 1,
    firstTree: ok ? 'readable' : 'not-observed',
    ok,
    outlier: false,
    ...(ok ? {} : { failure: { category: 'timeout' as const } }),
  };
}

test('summarizes successful values and uses the Tukey outlier rule', () => {
  const values = [10, 11, 12, 13, 100];
  assert.deepEqual(summarize(values, 1), {
    n: 5,
    min: 10,
    median: 12,
    p95: 100,
    max: 100,
    outlierCount: 1,
    outlierRule: 'tukey-1.5-iqr',
  });
  assert.equal(
    markOutliers(values.map((value, index) => sample(index + 1, value))).at(-1)?.outlier,
    true,
  );
});

test('keeps failures out of timing summaries and counts typed categories', () => {
  const measurement = buildMeasurement({
    transport: 'local',
    execution: 'fresh-process-cli',
    state: 'cold',
    screen: 'quiet',
    sampleMinimum: 10,
    operation: 'open-foreground',
    samples: [sample(1, 10), sample(2, 20, false)],
  });
  assert.equal(measurement.failures, 1);
  assert.deepEqual(measurement.failureCategories, { timeout: 1 });
  assert.equal(measurement.wallClockMs?.n, 1);
});
