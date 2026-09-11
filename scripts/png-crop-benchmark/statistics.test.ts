import { test } from 'vitest';
import assert from 'node:assert/strict';
import { speedup, summarize } from './statistics.ts';

test('summarize reports the middle of an odd sample set', () => {
  assert.deepEqual(summarize([9, 1, 5]), { medianMs: 5, bestMs: 1, worstMs: 9 });
});

test('summarize averages the two middle samples of an even set', () => {
  assert.equal(summarize([4, 8, 2, 6]).medianMs, 5);
});

test('summarize survives an empty sample set', () => {
  assert.deepEqual(summarize([]), { medianMs: 0, bestMs: 0, worstMs: 0 });
});

test('speedup expresses the old pipeline in multiples of the new one', () => {
  assert.equal(speedup(120, 40), 3);
  assert.equal(speedup(120, 0), 0);
});
