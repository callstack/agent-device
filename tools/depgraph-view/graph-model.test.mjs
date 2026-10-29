import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraphModel, refreshPairKinds, visibleKinds } from './graph-model.js';

test('keeps opposite imports separate and hides disabled kinds', () => {
  const graph = createGraphModel({
    zones: [],
    nodes: [
      { in: 1, out: 1 },
      { in: 1, out: 1 },
    ],
    edges: [
      [0, 1, 0, 0],
      [1, 0, 1, 0],
      [1, 0, 2, 0],
    ],
  });
  assert.equal(graph.pairs.length, 2);
  assert.deepEqual(
    graph.pairs.map(({ a, b }) => [a, b]),
    [
      [0, 1],
      [1, 0],
    ],
  );
  const kinds = new Set([0, 1]);
  refreshPairKinds(graph.pairs, kinds, false);
  assert.deepEqual(visibleKinds(graph.pairs[1], kinds, false), [1]);
});

test('hides transitively reachable value edges while preserving type imports', () => {
  const graph = createGraphModel({
    zones: [],
    nodes: [
      { in: 1, out: 1 },
      { in: 1, out: 1 },
    ],
    edges: [
      [0, 1, 0, 2],
      [0, 1, 1, 0],
    ],
  });
  const enabled = new Set([0, 1]);
  refreshPairKinds(graph.pairs, enabled, false);
  assert.equal(graph.pairs[0].display, 0);
  refreshPairKinds(graph.pairs, enabled, true);
  assert.equal(graph.pairs[0].display, 1);
  assert.deepEqual(visibleKinds(graph.pairs[0], enabled, true), [1]);
  refreshPairKinds(graph.pairs, new Set([0]), true);
  assert.equal(graph.pairs[0].display, -1);
});
