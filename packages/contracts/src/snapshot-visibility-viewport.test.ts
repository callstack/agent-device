import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatRole } from '@agent-device/kernel/snapshot';
import type { RawSnapshotNode, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { buildSnapshotNodeMap } from './snapshot-tree.ts';
import {
  collectViewportRects,
  createSnapshotVisibility,
  findNearestScrollableAncestor,
  isTapPointInsideViewport,
  resolveViewportRect,
} from './snapshot-visibility.ts';

function node(input: RawSnapshotNode): SnapshotNode {
  return { ...input, ref: `@e${input.index}`, kind: formatRole(input.type ?? 'Element') };
}

test('findNearestScrollableAncestor resolves the enclosing scroll container', () => {
  const nodes = [
    node({ index: 0, type: 'Window' }),
    node({ index: 1, type: 'ScrollView', parentIndex: 0 }),
    node({ index: 2, type: 'Button', parentIndex: 1 }),
  ];

  assert.strictEqual(
    findNearestScrollableAncestor(nodes[2]!, buildSnapshotNodeMap(nodes)),
    nodes[1],
  );
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
