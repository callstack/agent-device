import { test } from 'vitest';
import assert from 'node:assert/strict';
import { findNearestAncestor } from '../../snapshot/snapshot-processing.ts';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

test('findNearestAncestor resolves parents by snapshot index rather than array position', () => {
  const nodes: SnapshotNode[] = [
    { ref: 'e10', index: 10, type: 'Window' },
    { ref: 'e30', index: 30, parentIndex: 20, type: 'Text' },
    { ref: 'e20', index: 20, parentIndex: 10, type: 'Cell' },
  ];

  const ancestor = findNearestAncestor(nodes, nodes[1]!, (node) => node.type === 'Window');

  assert.equal(ancestor?.index, 10);
});
