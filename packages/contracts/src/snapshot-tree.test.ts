import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatRole } from '@agent-device/kernel/snapshot';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  buildSnapshotNodeMap,
  findNearestAncestor,
  findSnapshotAncestor,
} from './snapshot-tree.ts';

function node(input: RawSnapshotNode): SnapshotNode {
  return { ...input, ref: `@e${input.index}`, kind: formatRole(input.type ?? 'Element') };
}

test('findSnapshotAncestor walks non-contiguous parent indexes until resolver returns a value', () => {
  const nodes: SnapshotNode[] = [
    { ref: 'e10', index: 10, type: 'Window', kind: formatRole('Window') },
    { ref: 'e30', index: 30, parentIndex: 20, type: 'Text', kind: formatRole('Text') },
    { ref: 'e20', index: 20, parentIndex: 10, type: 'Cell', kind: formatRole('Cell') },
  ];
  const visited: number[] = [];

  const ancestor = findSnapshotAncestor(nodes, nodes[1]!, buildSnapshotNodeMap(nodes), (n) => {
    visited.push(n.index);
    return n.type === 'Window' ? n : null;
  });

  assert.deepEqual(visited, [20, 10]);
  assert.equal(ancestor?.index, 10);
});

test('findSnapshotAncestor terminates on a parent-linkage cycle without resolving', () => {
  const nodes: SnapshotNode[] = [
    { ref: 'e1', index: 1, parentIndex: 2, type: 'Text', kind: formatRole('Text') },
    { ref: 'e2', index: 2, parentIndex: 1, type: 'Cell', kind: formatRole('Cell') },
  ];

  const ancestor = findSnapshotAncestor(nodes, nodes[0]!, buildSnapshotNodeMap(nodes), (n) =>
    n.type === 'Window' ? n : null,
  );

  assert.equal(ancestor, null);
});

test('findNearestAncestor adapts a predicate to the shared tree walk', () => {
  const nodes: SnapshotNode[] = [
    { ref: 'e10', index: 10, type: 'Window', kind: formatRole('Window') },
    { ref: 'e30', index: 30, parentIndex: 20, type: 'Text', kind: formatRole('Text') },
    { ref: 'e20', index: 20, parentIndex: 10, type: 'Cell', kind: formatRole('Cell') },
  ];

  const isWindow = (ancestor: SnapshotNode) => ancestor.type === 'Window';

  assert.equal(findNearestAncestor(nodes, nodes[1]!, isWindow)?.index, 10);
});

test('snapshot tree identifies nodes through their stable indexes', () => {
  const nodes = [
    node({ index: 0, type: 'Window' }),
    node({ index: 1, type: 'ScrollView', parentIndex: 0 }),
    node({ index: 2, type: 'Button', parentIndex: 1 }),
  ];

  assert.strictEqual(buildSnapshotNodeMap(nodes).get(1), nodes[1]);
});
