import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  buildSnapshotNodeMap,
  extractNodeText,
  findNearestAncestor,
  findNearestScrollableAncestor,
  findSnapshotAncestor,
  isFillableType,
  isNodeVisibleInEffectiveViewport,
  isNodeVisibleOnScreen,
  isScrollableNodeLike,
  isScrollableType,
  isTapPointInsideViewport,
  normalizeType,
  resolveEffectiveViewportRect,
  resolveViewportRect,
} from './facades/snapshot.ts';

function node(input: RawSnapshotNode): SnapshotNode {
  return { ...input, ref: `@e${input.index}` };
}

test('snapshot text semantics normalize roles, identify fillable controls, and extract the first text field', () => {
  assert.equal(normalizeType('XCUIElementTypeButton'), 'button');
  assert.equal(normalizeType('android.widget.EditText'), 'edittext');
  assert.equal(isFillableType('XCUIElementTypeTextField', 'ios'), true);
  assert.equal(isFillableType('android.widget.EditText', 'android'), true);
  assert.equal(
    extractNodeText({
      label: '  ',
      value: '  Enter name  ',
      identifier: 'name',
    }),
    'Enter name',
  );
});

test('findSnapshotAncestor walks non-contiguous parent indexes until resolver returns a value', () => {
  const nodes: SnapshotNode[] = [
    { ref: 'e10', index: 10, type: 'Window' },
    { ref: 'e30', index: 30, parentIndex: 20, type: 'Text' },
    { ref: 'e20', index: 20, parentIndex: 10, type: 'Cell' },
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
    { ref: 'e1', index: 1, parentIndex: 2, type: 'Text' },
    { ref: 'e2', index: 2, parentIndex: 1, type: 'Cell' },
  ];

  const ancestor = findSnapshotAncestor(nodes, nodes[0]!, buildSnapshotNodeMap(nodes), (n) =>
    n.type === 'Window' ? n : null,
  );

  assert.equal(ancestor, null);
});

test('findNearestAncestor adapts a predicate to the shared tree walk', () => {
  const nodes: SnapshotNode[] = [
    { ref: 'e10', index: 10, type: 'Window' },
    { ref: 'e30', index: 30, parentIndex: 20, type: 'Text' },
    { ref: 'e20', index: 20, parentIndex: 10, type: 'Cell' },
  ];

  assert.equal(
    findNearestAncestor(nodes, nodes[1]!, (ancestor) => ancestor.type === 'Window')?.index,
    10,
  );
});

test('snapshot tree and scroll semantics identify nodes through their stable indexes', () => {
  const nodes = [
    node({ index: 0, type: 'Window' }),
    node({ index: 1, type: 'ScrollView', parentIndex: 0 }),
    node({ index: 2, type: 'Button', parentIndex: 1 }),
  ];
  const byIndex = buildSnapshotNodeMap(nodes);

  assert.strictEqual(byIndex.get(1), nodes[1]);
  assert.equal(isScrollableType('android.widget.RecyclerView'), true);
  assert.equal(isScrollableNodeLike(nodes[1]!), true);
  assert.equal(isScrollableNodeLike({ role: 'scrollbar' }), true);
  assert.strictEqual(findNearestScrollableAncestor(nodes[2]!, byIndex), nodes[1]);
});

test('resolveViewportRect selects the containing application viewport', () => {
  const viewport: Rect = { x: 0, y: 0, width: 300, height: 500 };
  const target: Rect = { x: 20, y: 20, width: 40, height: 40 };
  const nodes = [node({ index: 0, type: 'Application', rect: viewport })];

  assert.deepEqual(resolveViewportRect(nodes, target), viewport);
});

test('snapshot visibility uses the nearest scrollable viewport before applying the tap-point rule', () => {
  const nodes = [
    node({ index: 0, type: 'Window', rect: { x: 0, y: 0, width: 100, height: 100 } }),
    node({
      index: 1,
      type: 'ScrollView',
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 100, height: 100 },
    }),
    node({
      index: 2,
      type: 'Button',
      parentIndex: 1,
      rect: { x: 80, y: 80, width: 50, height: 50 },
    }),
  ];
  const byIndex = buildSnapshotNodeMap(nodes);

  assert.deepEqual(resolveEffectiveViewportRect(nodes[2]!, nodes, byIndex), nodes[1]!.rect);
  assert.equal(isNodeVisibleInEffectiveViewport(nodes[2]!, nodes, byIndex), true);
  assert.equal(isNodeVisibleOnScreen(nodes[2]!, nodes, byIndex), false);
  assert.equal(isTapPointInsideViewport(nodes[2]!.rect!, nodes[0]!.rect!), false);
  assert.equal(isTapPointInsideViewport(nodes[2]!.rect!, null), true);
});
