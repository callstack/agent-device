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
  applied: true,
  restored: true,
  fixtureLaunchCompatible: true,
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
  assert.ok(result.reasons.some((reason) => reason.includes('unsupported-mechanism/permission')));
});

test('does not let failed samples contribute fabricated zero latency', () => {
  const cell = readableCell('public-macos-ax', 'warm', 'list');
  const failed = {
    ...cell.acquisitionSamples[0]!,
    ok: false,
    firstTree: 'not-observed' as const,
    firstLookMs: 0,
    metrics: { ...cell.acquisitionSamples[0]!.metrics!, durationMs: 0 },
    failure: { kind: 'timeout' as const, code: 'batch-duration-limit' },
  };
  const result = decideSpike(
    [{ ...cell, acquisitionSamples: [failed, ...cell.acquisitionSamples.slice(1)] }],
    lifecycle,
    preferences,
    DEFAULT_SPIKE_LIMITS,
    'completed',
    [{ candidate: 'public-macos-ax' }],
  );
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.reasons.some((reason) => reason.includes('duration bound')));
  assert.ok(result.reasons.some((reason) => reason.includes('not produce 20 readable samples')));
});

test('reports a decisive partial corpus failure instead of replacing it with completeness', () => {
  const cell = readableCell('public-macos-ax', 'warm', 'list');
  const slow = {
    ...cell,
    acquisitionSamples: cell.acquisitionSamples.map((sample) => ({
      ...sample,
      metrics: { ...sample.metrics!, durationMs: 1_000 },
    })),
  };
  const result = decideSpike([slow], lifecycle, preferences, DEFAULT_SPIKE_LIMITS, 'completed', [
    { candidate: 'public-macos-ax' },
  ]);
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.reasons.some((reason) => reason.includes('warm/list acquisition')));
  assert.equal(
    result.reasons.some((reason) => reason.includes('required corpus')),
    false,
  );
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
