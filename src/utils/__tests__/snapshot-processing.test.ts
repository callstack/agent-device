import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildSnapshotNodeByIndex,
  findNearestAncestor,
  findSnapshotAncestor,
} from '../../snapshot/snapshot-processing.ts';
import type { SnapshotNode } from '../../kernel/snapshot.ts';

test('findSnapshotAncestor walks non-contiguous parent indexes until resolver returns a value', () => {
  const nodes: SnapshotNode[] = [
    { ref: 'e10', index: 10, type: 'Window' },
    { ref: 'e30', index: 30, parentIndex: 20, type: 'Text' },
    { ref: 'e20', index: 20, parentIndex: 10, type: 'Cell' },
  ];
  const visited: number[] = [];

  const ancestor = findSnapshotAncestor(
    nodes,
    nodes[1]!,
    buildSnapshotNodeByIndex(nodes),
    (node) => {
      visited.push(node.index);
      return node.type === 'Window' ? node : null;
    },
  );

  assert.deepEqual(visited, [20, 10]);
  assert.equal(ancestor?.index, 10);
});

test('findNearestAncestor resolves parents by snapshot index rather than array position', () => {
  const nodes: SnapshotNode[] = [
    { ref: 'e10', index: 10, type: 'Window' },
    { ref: 'e30', index: 30, parentIndex: 20, type: 'Text' },
    { ref: 'e20', index: 20, parentIndex: 10, type: 'Cell' },
  ];

  const ancestor = findNearestAncestor(nodes, nodes[1]!, (node) => node.type === 'Window');

  assert.equal(ancestor?.index, 10);
});
