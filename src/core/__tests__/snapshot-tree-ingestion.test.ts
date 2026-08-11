import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeSnapshotTree, pruneGroupNodes } from '../snapshot-tree-ingestion.ts';

test('pruneGroupNodes drops unlabeled group wrappers and rebalances depth', () => {
  const raw = [
    { index: 0, depth: 0, type: 'XCUIElementTypeWindow', label: 'Root' },
    { index: 1, depth: 1, type: 'XCUIElementTypeGroup' },
    { index: 2, depth: 2, type: 'XCUIElementTypeButton', label: 'Continue' },
  ];
  const pruned = pruneGroupNodes(raw);
  assert.equal(pruned.length, 2);
  assert.equal(pruned[1]!.depth, 1);
  assert.equal(pruned[1]!.label, 'Continue');
});

test('normalizeSnapshotTree rewrites indexes and keeps explicit parents when valid', () => {
  const normalized = normalizeSnapshotTree([
    { index: 10, depth: 0, type: 'Window' },
    { index: 30, depth: 1, parentIndex: 10, type: 'Cell' },
    { index: 50, depth: 2, parentIndex: 30, type: 'Button' },
  ]);

  assert.deepEqual(
    normalized.map((node) => ({
      index: node.index,
      depth: node.depth,
      parentIndex: node.parentIndex,
    })),
    [
      { index: 0, depth: 0, parentIndex: undefined },
      { index: 1, depth: 1, parentIndex: 0 },
      { index: 2, depth: 2, parentIndex: 1 },
    ],
  );
});
