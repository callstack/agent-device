import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decideSpike } from './decision.ts';
import { DEFAULT_SPIKE_LIMITS } from './limits.ts';
import type { CandidateId, LifecycleEvidence, PreferenceEvidence, SpikeCell } from './types.ts';
import type { LocalState, ScreenId } from '../ios-snapshot-benchmark/types.ts';

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

test('selects one complete viable bridge without requiring every candidate to pass', () => {
  const states: LocalState[] = ['cold-cold', 'cold', 'warm', 'relaunch'];
  const screens: ScreenId[] = [
    'quiet',
    'list',
    'nested-scroll',
    'alert',
    'system-surface',
    'xctest-stress',
  ];
  const cells = states.flatMap((state) =>
    screens.map((screen) => readableCell('public-macos-ax', state, screen)),
  );
  const result = decideSpike(cells, lifecycle, preferences, DEFAULT_SPIKE_LIMITS, 'completed', [
    { candidate: 'public-macos-ax' },
    {
      candidate: 'private-coresimulator-ax',
      failure: { kind: 'unsupported-mechanism', code: 'private-tool-unavailable' },
    },
  ]);
  assert.deepEqual(result, { decision: 'GO', reasons: [] });
});

function readableCell(candidate: CandidateId, state: LocalState, screen: ScreenId): SpikeCell {
  const sampleMinimum = state === 'cold' || state === 'cold-cold' ? 10 : 20;
  return {
    candidate,
    state,
    screen,
    sampleMinimum,
    acquisitionSamples: Array.from({ length: sampleMinimum }, (_, index) => ({
      index: index + 1,
      candidate,
      state,
      screen,
      startedAt: '2026-09-01T00:00:00.000Z',
      finishedAt: '2026-09-01T00:00:00.010Z',
      operation: 'acquisition' as const,
      wallClockMs: 10,
      firstLookMs: 100,
      firstTree: 'readable' as const,
      ok: true,
      metrics: {
        requestBytes: 1,
        responseBytes: 1,
        nodeCount: 1,
        maxTraversalDepth: 0,
        cpuMs: 1,
        memoryBytes: 1,
        durationMs: 10,
      },
    })),
    presentationSamples: [],
  };
}
