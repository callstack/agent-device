import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DEFAULT_SPIKE_LIMITS, encodeFrame, validateRawAcquisition } from './limits.ts';

const acquisition = {
  targetId: 'simulator:test',
  targetGeneration: 'generation-1',
  nodes: [
    { id: 'n0', type: 'XCUIElementTypeApplication', role: 'AXApplication' },
    { id: 'n1', parentId: 'n0', role: 'AXWindow', frame: { x: 0, y: 0, width: 100, height: 200 } },
  ],
  viewport: { kind: 'reported', rect: { x: 0, y: 0, width: 100, height: 200 } },
  truncated: false,
  residue: [],
} as const;

test('accepts a raw tree and reports structural depth without publishing it on nodes', () => {
  const result = validateRawAcquisition(acquisition, DEFAULT_SPIKE_LIMITS);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.maxTraversalDepth, 1);
    assert.equal(result.acquisition.nodes[0]?.type, 'XCUIElementTypeApplication');
  }
  assert.equal('depth' in acquisition.nodes[0], false);
  assert.equal('hittable' in acquisition.nodes[0], false);
});

test('rejects presentation facts in the acquisition reader', () => {
  const result = validateRawAcquisition(
    {
      ...acquisition,
      nodes: [{ id: 'n0', visibleToUser: true }],
    },
    DEFAULT_SPIKE_LIMITS,
  );
  assert.deepEqual(result, { ok: false, code: 'node-contains-presentation-fact' });
});

test('rejects cycles, missing parents, and resource-limit violations', () => {
  assert.deepEqual(
    validateRawAcquisition(
      { ...acquisition, nodes: [{ id: 'n0', parentId: 'missing' }] },
      DEFAULT_SPIKE_LIMITS,
    ),
    { ok: false, code: 'parent-node-missing' },
  );
  assert.deepEqual(
    validateRawAcquisition(
      { ...acquisition, nodes: [{ id: 'n0', parentId: 'n0' }] },
      DEFAULT_SPIKE_LIMITS,
    ),
    { ok: false, code: 'traversal-depth-exceeded' },
  );
  assert.deepEqual(
    validateRawAcquisition(
      { ...acquisition, nodes: Array.from({ length: 3 }, (_, index) => ({ id: `n${index}` })) },
      {
        ...DEFAULT_SPIKE_LIMITS,
        maxNodes: 2,
      },
    ),
    { ok: false, code: 'node-limit-exceeded' },
  );
});

test('frames are newline-delimited and byte bounded', () => {
  const frame = encodeFrame({ id: 'one', text: 'ok' });
  assert.equal(frame.line.endsWith('\n'), true);
  assert.equal(frame.bytes, Buffer.byteLength(frame.line));
});
