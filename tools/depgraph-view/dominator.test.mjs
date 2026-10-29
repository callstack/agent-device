import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDominatorAnalyzer } from './dominator.js';

test('computes dominated branches through reconverging imports and ignores type edges', () => {
  const nodes = ['entry', 'left', 'right', 'join', 'leaf', 'type-only'].map((id, i) => ({
    id,
    loc: i + 1,
  }));
  const edges = [
    [0, 1, 0],
    [0, 2, 0],
    [1, 3, 0],
    [2, 3, 0],
    [3, 4, 0],
    [0, 5, 1],
  ];
  const result = createDominatorAnalyzer(nodes, edges)(0);
  assert.equal(result.reachable, 5);
  assert.equal(result.reachableLoc, 15);
  assert.deepEqual(
    result.bottlenecks.map(({ index, files, loc }) => [index, files, loc]),
    [
      [3, 2, 9],
      [4, 1, 5],
      [1, 1, 2],
      [2, 1, 3],
    ],
  );
});
