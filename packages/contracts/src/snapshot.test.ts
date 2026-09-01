import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  buildSnapshotNodeMap,
  collectViewportRects,
  createSnapshotVisibility,
  extractNodeText,
  findNearestAncestor,
  findNearestScrollableAncestor,
  findSnapshotAncestor,
  isFillableType,
  isScrollableNodeLike,
  isScrollableType,
  isTapPointInsideViewport,
  normalizeType,
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

  const isWindow = (ancestor: SnapshotNode) => ancestor.type === 'Window';

  assert.equal(findNearestAncestor(nodes, nodes[1]!, isWindow)?.index, 10);
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
  assert.deepEqual(resolveViewportRect(nodes, target, [viewport]), viewport);
});

test('collectViewportRects reports exactly what resolveViewportRect gathers when uncached (#1970)', () => {
  const viewport: Rect = { x: 0, y: 0, width: 300, height: 500 };
  const nodes = [
    node({ index: 0, type: 'Application', rect: viewport }),
    node({
      index: 1,
      type: 'Button',
      parentIndex: 0,
      rect: { x: 10, y: 10, width: 20, height: 20 },
    }),
    // Invalid rects (non-finite) are excluded, same as resolveViewportRect's own inline gather.
    node({ index: 2, type: 'Window', rect: { x: Number.NaN, y: 0, width: 10, height: 10 } }),
  ];

  assert.deepEqual(collectViewportRects(nodes), [viewport]);

  // A caller sharing this precomputed set across several `resolveViewportRect`
  // calls (as `analyzeSelectorMatches` now does for its lazily-built
  // visibility index) must get the identical answer a fresh, uncached call
  // would — precomputing must not change which viewport wins.
  const target: Rect = { x: 20, y: 20, width: 40, height: 40 };
  assert.deepEqual(
    resolveViewportRect(nodes, target, collectViewportRects(nodes)),
    resolveViewportRect(nodes, target),
  );
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
  const visibility = createSnapshotVisibility(nodes);

  assert.deepEqual(visibility.resolveEffectiveViewport(nodes[2]!), nodes[1]!.rect);
  assert.equal(visibility.isVisibleInEffectiveViewport(nodes[2]!), true);
  assert.equal(visibility.isVisibleOnScreen(nodes[2]!), false);
  assert.equal(isTapPointInsideViewport(nodes[2]!.rect!, nodes[0]!.rect!), false);
  assert.equal(isTapPointInsideViewport(nodes[2]!.rect!, null), true);
});
