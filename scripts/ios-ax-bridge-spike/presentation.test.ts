import assert from 'node:assert/strict';
import { test } from 'vitest';
import { presentAcquisitionForMeasurement } from './presentation.ts';
import type { RawAcquisition } from './types.ts';

test('prototype presentation creates the #2190 acquired carrier without semantic fields', () => {
  const raw: RawAcquisition = {
    targetId: 'simulator:test',
    targetGeneration: 'generation-1',
    nodes: [
      { id: 'root', role: 'AXApplication', enabled: true },
      { id: 'child', parentId: 'root', role: 'AXWindow' },
    ],
    viewport: { kind: 'missing', reason: 'not-provided' },
    truncated: false,
    residue: [],
  };
  const result = presentAcquisitionForMeasurement(raw);
  assert.equal(result.acquisition.producer, 'simulator-ax-bridge');
  assert.equal(result.acquisition.nodes.length, 2);
  assert.equal(result.acquisition.nodes[1]?.parentIndex, 0);
  assert.equal('hittable' in result.acquisition.nodes[0]!, false);
  assert.equal(result.measurement.nodeCount, 2);
});
