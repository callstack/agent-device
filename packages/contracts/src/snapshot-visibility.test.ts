import { expect, test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { createSnapshotVisibility } from './snapshot-visibility.ts';

function snapshotNodes(nodes: Array<Omit<SnapshotNode, 'ref'>>): SnapshotNode[] {
  return nodes.map((node) => ({ ref: `@e${node.index}`, ...node }));
}

test('rootless effective visibility never resolves a target-dependent containing rectangle', () => {
  const nodes = snapshotNodes([
    {
      index: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 1080, height: 2400 },
    },
    ...Array.from({ length: 64 }, (_, offset) => ({
      index: offset + 1,
      parentIndex: 0,
      type: 'android.widget.TextView',
      rect: { x: 20, y: offset * 30, width: 200, height: 24 },
    })),
  ]);
  const materialized = { nodeMap: 0, viewportRects: 0, containingRectFallbacks: 0 };
  const visibility = createSnapshotVisibility(nodes, {
    onNodeMapBuilt: () => materialized.nodeMap++,
    onViewportRectsCollected: () => materialized.viewportRects++,
    onContainingRectFallback: () => materialized.containingRectFallbacks++,
  });

  expect(nodes.slice(1).map(visibility.isVisibleInEffectiveViewport)).toEqual(
    Array.from({ length: 64 }, () => true),
  );
  expect(materialized).toEqual({ nodeMap: 1, viewportRects: 1, containingRectFallbacks: 0 });
});

test('effective visibility keeps explicit-root and nearest-scroll clipping semantics', () => {
  const nodes = snapshotNodes([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 100, height: 100 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      rect: { x: 120, y: 20, width: 20, height: 20 },
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'ScrollView',
      rect: { x: 0, y: 0, width: 50, height: 50 },
    },
    {
      index: 3,
      parentIndex: 2,
      type: 'Button',
      rect: { x: 0, y: 60, width: 20, height: 20 },
    },
  ]);
  const visibility = createSnapshotVisibility(nodes);

  expect(visibility.isVisibleInEffectiveViewport(nodes[1]!)).toBe(false);
  expect(visibility.isVisibleInEffectiveViewport(nodes[3]!)).toBe(false);
});

test('invalid explicit viewport roots fail open without containing-rectangle fallback', () => {
  const nodes = snapshotNodes([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 0, height: 100 } },
    { index: 1, type: 'Window', rect: { x: Number.NaN, y: 0, width: 100, height: 100 } },
    { index: 2, type: 'Button', rect: { x: 500, y: 500, width: 20, height: 20 } },
  ]);
  let containingRectFallbacks = 0;
  const visibility = createSnapshotVisibility(nodes, {
    onContainingRectFallback: () => containingRectFallbacks++,
  });

  expect(visibility.isVisibleInEffectiveViewport(nodes[2]!)).toBe(true);
  expect(containingRectFallbacks).toBe(0);
});
