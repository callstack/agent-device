import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseLocalStates,
  parseRtt,
  parseSampleCount,
  parseScreenIds,
  sampleMinimumForState,
} from './definitions.ts';

test('parses the versioned state and screen cells', () => {
  assert.deepEqual(parseLocalStates('warm,cold,warm'), ['warm', 'cold']);
  assert.deepEqual(parseScreenIds('quiet,alert,quiet'), ['quiet', 'alert']);
  assert.deepEqual(parseRtt('80,0,20,0'), [80, 0, 20]);
  assert.equal(sampleMinimumForState('cold-cold'), 10);
  assert.equal(sampleMinimumForState('relaunch'), 20);
});

test('enforces the warm and cold sample minima', () => {
  assert.equal(parseSampleCount('10', ['cold']), 10);
  assert.throws(() => parseSampleCount('10', ['warm']), /at least 20/);
  assert.equal(parseSampleCount(undefined, ['cold', 'warm']), 20);
});
