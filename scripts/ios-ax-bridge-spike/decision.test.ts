import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decideSpike } from './decision.ts';
import { DEFAULT_SPIKE_LIMITS } from './limits.ts';
import type { LifecycleEvidence, PreferenceEvidence } from './types.ts';

const lifecycle: LifecycleEvidence = {
  source: 'framed-protocol-fixture',
  crash: { failure: 'process-crash', recovered: true },
  timeout: { failure: 'timeout', recovered: true },
  cancellation: { failure: 'cancelled', recovered: true },
  staleGeneration: { failure: 'stale-generation', recovered: true },
};

const preferences: PreferenceEvidence = {
  applied: false,
  restored: true,
  simulatorStateBefore: 'Shutdown',
  diffs: [],
};

test('fails closed when a bridge has no readable corpus cells', () => {
  const result = decideSpike([], lifecycle, preferences, DEFAULT_SPIKE_LIMITS, 'completed', [
    {
      candidate: 'public-macos-ax',
      failure: { kind: 'unsupported-mechanism', code: 'permission' },
    },
  ]);
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.reasons.some((reason) => reason.includes('public-macos-ax produced no cells')));
});
