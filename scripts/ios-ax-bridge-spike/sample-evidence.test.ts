import assert from 'node:assert/strict';
import { test } from 'vitest';
import { appendSamples, type CapturedResponse } from './sample-evidence.ts';
import type { SpikeSample } from './types.ts';

test('keeps one raw acquisition exemplar while retaining every sample measurement', () => {
  const acquisitionSamples: SpikeSample[] = [];
  const presentationSamples: SpikeSample[] = [];
  const captured: CapturedResponse = {
    startedAt: '2026-09-01T00:00:00.000Z',
    wallClockMs: 12,
    stderr: '',
    response: {
      version: 1,
      id: 'sample',
      candidate: 'public-macos-ax',
      ok: true,
      acquisition: {
        targetId: 'simulator:test',
        nodes: [{ id: 'root', role: 'AXGroup' }],
        viewport: { kind: 'missing', reason: 'not-provided' },
        truncated: false,
        residue: [],
      },
      metrics: {
        requestBytes: 1,
        responseBytes: 2,
        nodeCount: 1,
        maxTraversalDepth: 0,
        cpuMs: 1,
        memoryBytes: 1,
        durationMs: 12,
      },
    },
  };

  for (const index of [0, 1]) {
    appendSamples(
      'public-macos-ax',
      'warm',
      'quiet',
      index,
      captured,
      3,
      acquisitionSamples,
      presentationSamples,
    );
  }

  assert.equal(acquisitionSamples.length, 2);
  assert.ok(acquisitionSamples[0]?.acquisition);
  assert.equal(acquisitionSamples[1]?.acquisition, undefined);
  assert.equal(presentationSamples.length, 2);
  assert.equal(
    presentationSamples.every((sample) => sample.acquisition === undefined),
    true,
  );
});
