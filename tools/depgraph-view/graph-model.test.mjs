import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraphModel, refreshPairKinds, visibleCycleFocus } from './graph-model.js';

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
  assert.deepEqual(
    graph.pairs.map((pair) => pair.display),
    [0, 1],
  );
  refreshPairKinds(graph.pairs, new Set([0]), false);
  assert.deepEqual(
    graph.pairs.map((pair) => pair.display),
    [0, -1],
  );
});

test('hides transitively reachable value edges and keeps other imports', () => {
  const graph = createGraphModel({
    zones: [],
    nodes: [
      { in: 1, out: 1 },
      { in: 1, out: 1 },
    ],
    edges: [
      [0, 1, 0, 2],
      [1, 0, 1, 0],
    ],
  });
  const enabled = new Set([0, 1]);
  refreshPairKinds(graph.pairs, enabled, false);
  assert.equal(graph.pairs[0].display, 0);
  refreshPairKinds(graph.pairs, enabled, true);
  assert.deepEqual(
    graph.pairs.map((pair) => pair.display),
    [-1, 1],
  );
  refreshPairKinds(graph.pairs, new Set([0]), true);
  assert.equal(graph.pairs[0].display, -1);
});

test('highlights only complete visible directed cycle paths', () => {
  const graph = createGraphModel({
    zones: [],
    nodes: Array.from({ length: 4 }, (_, z) => ({ z, in: 1, out: 1 })),
    edges: [
      [0, 1, 1, 0],
      [1, 0, 0, 0],
      [2, 3, 1, 0],
      [3, 2, 0, 0],
      [1, 2, 0, 0],
    ],
  });
  const cycles = [
    { kind: 'type', path: [0, 1, 0] },
    { kind: 'type', path: [2, 3, 2] },
  ];
  const visible = [true, true, true, true];
  const focus = (kinds) => {
    refreshPairKinds(graph.pairs, new Set(kinds), false);
    return visibleCycleFocus(cycles, graph.pairs, graph.nodes, visible);
  };
  assert.deepEqual([...focus([0, 1]).focusPairs], [0, 1, 2, 3]);
  assert.equal(focus([0]).focusPairs.size, 0);
  visible[2] = false;
  assert.deepEqual([...focus([0, 1]).focusPairs], [0, 1]);
});
