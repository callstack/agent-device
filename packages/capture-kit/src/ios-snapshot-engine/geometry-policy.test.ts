import { expect, test } from 'vitest';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { foldIosSnapshot } from './geometry.ts';
import { collectModalContainedIndexes } from './geometry-policy.ts';
import { projectIosSnapshot } from './projection.ts';

const VIEWPORT = { x: 0, y: 0, width: 402, height: 874 };
const SHEET: Rect = { x: 16, y: 62, width: 370, height: 747 };

type PresentationShape = Readonly<{
  title: string;
  containerRole?: string;
  rect?: Rect;
  dimming?: 'direct' | 'nested';
}>;

/**
 * Mirrors a react-navigation capture: the presenting container carries only a drop shadow with
 * UIKit's dimming view below it, while each modal presentation carries a dimming view as a
 * direct child of its transition view.
 */
function presentationSubtree(
  start: number,
  depth: number,
  parentIndex: number,
  shape: PresentationShape,
): RawSnapshotNode[] {
  const rect = shape.rect ?? VIEWPORT;
  const dimmingRect: Rect = {
    x: -rect.width,
    y: -rect.height,
    width: rect.width * 3,
    height: rect.height * 3,
  };
  const nodes: RawSnapshotNode[] = [
    snapshotNode(start, depth, parentIndex, 'UITransitionView', 'Other'),
    snapshotNode(start + 1, depth + 1, start, 'UIDropShadowView', 'Other', undefined, rect),
    snapshotNode(
      start + 2,
      depth + 2,
      start + 1,
      shape.containerRole ?? 'RNSModalScreen',
      'Other',
      shape.title,
      rect,
    ),
    snapshotNode(start + 3, depth + 3, start + 2, undefined, 'Button', `Push from ${shape.title}`, {
      x: rect.x + 12,
      y: rect.y + 92,
      width: 120,
      height: 40,
    }),
  ];
  if ((shape.dimming ?? 'direct') === 'direct') {
    nodes.splice(
      1,
      0,
      snapshotNode(start + 4, depth + 1, start, 'UIDimmingView', 'Other', undefined, dimmingRect),
    );
  } else {
    nodes.splice(
      2,
      0,
      snapshotNode(
        start + 4,
        depth + 2,
        start + 1,
        'UIDimmingView',
        'Other',
        undefined,
        dimmingRect,
      ),
    );
  }
  return nodes;
}

function snapshotNode(
  index: number,
  depth: number,
  parentIndex: number | undefined,
  role: string | undefined,
  type: string,
  label?: string,
  rect: Rect = VIEWPORT,
): RawSnapshotNode {
  return {
    index,
    depth,
    ...(parentIndex === undefined ? {} : { parentIndex }),
    type,
    ...(role ? { role } : {}),
    ...(label ? { label } : {}),
    rect,
    hittable: true,
  };
}

function windowWith(children: RawSnapshotNode[]): RawSnapshotNode[] {
  return [snapshotNode(0, 0, undefined, 'UIWindow', 'Window'), ...children];
}

function stackedPresentations(): RawSnapshotNode[] {
  return windowWith([
    ...presentationSubtree(1, 1, 0, {
      title: 'Article by Dalek',
      containerRole: 'RCTSurfaceHostingProxyRootView',
      dimming: 'nested',
    }),
    ...presentationSubtree(6, 1, 0, { title: 'Albums', rect: SHEET }),
    ...presentationSubtree(11, 1, 0, { title: 'Article by The Doctor' }),
  ]);
}

test('dims away every earlier presentation the covering dimming view spans', () => {
  const contained = collectModalContainedIndexes(stackedPresentations());
  expect([...contained].sort((left, right) => left - right)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  ]);
});

test('keeps the covering presentation and everything it contains', () => {
  const contained = collectModalContainedIndexes(stackedPresentations());
  expect([...contained].filter((index) => index >= 11)).toEqual([]);
});

test('presents only the covering subtree through the fold', () => {
  const folded = foldIosSnapshot(stackedPresentations(), VIEWPORT, false, 'cursor-projected');
  expect(folded.nodes.flatMap((node) => (node.raw.label ? [node.raw.label] : []))).toEqual([
    'Article by The Doctor',
    'Push from Article by The Doctor',
  ]);
});

test('records how many sources the cut removed', () => {
  const folded = foldIosSnapshot(stackedPresentations(), VIEWPORT, false, 'cursor-projected');
  expect(folded.stats.modalContainedNodeCount).toBe(10);
  expect(folded.stats.sourceNodeCount).toBe(16);
});

test('publishes an empty projection when a scope names a modal-contained screen', () => {
  const folded = foldIosSnapshot(stackedPresentations(), VIEWPORT, false, 'cursor-projected');
  const covered = projectIosSnapshot({
    nodes: folded.nodes,
    projection: 'regular',
    scope: 'Albums',
    depth: null,
    foldPolicy: 'cursor-projected',
  });
  const covering = projectIosSnapshot({
    nodes: folded.nodes,
    projection: 'regular',
    scope: 'Article by The Doctor',
    depth: null,
    foldPolicy: 'cursor-projected',
  });
  expect(covered.nodes).toEqual([]);
  expect(covering.nodes.length).toBeGreaterThan(0);
});

test('spares an earlier sibling that is not a presentation container', () => {
  const nodes = windowWith([
    snapshotNode(1, 1, 0, 'RCTSurfaceHostingProxyRootView', 'Other'),
    snapshotNode(2, 2, 1, undefined, 'Button', 'Live control', {
      x: 12,
      y: 154,
      width: 120,
      height: 40,
    }),
    ...presentationSubtree(3, 1, 0, { title: 'Albums' }),
  ]);
  expect(collectModalContainedIndexes(nodes).size).toBe(0);
});

test('fails closed when the last sibling is not a presentation container', () => {
  const nodes = windowWith([
    ...presentationSubtree(1, 1, 0, { title: 'Article by Dalek' }),
    snapshotNode(6, 1, 0, '_UIAlertControllerView', 'Other', 'Don’t leave'),
    snapshotNode(7, 2, 6, 'UIDimmingView', 'Other'),
  ]);
  expect(collectModalContainedIndexes(nodes).size).toBe(0);
});

test('fails closed when the dimming view sits below the presentation container', () => {
  const nodes = windowWith([
    ...presentationSubtree(1, 1, 0, { title: 'Article by Dalek' }),
    ...presentationSubtree(6, 1, 0, { title: 'Albums', dimming: 'nested' }),
  ]);
  expect(collectModalContainedIndexes(nodes).size).toBe(0);
});

test('fails closed when the dimming view does not span the earlier container', () => {
  const nodes = windowWith([
    ...presentationSubtree(1, 1, 0, { title: 'Article by Dalek' }),
    snapshotNode(6, 1, 0, 'UITransitionView', 'Other'),
    snapshotNode(7, 2, 6, 'UIDimmingView', 'Other', undefined, {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    }),
    snapshotNode(8, 2, 6, 'UIDropShadowView', 'Other', undefined, SHEET),
  ]);
  expect(collectModalContainedIndexes(nodes).size).toBe(0);
});

test('stays inert on a tree that reports no UIKit class names', () => {
  const nodes = windowWith([
    snapshotNode(1, 1, 0, undefined, 'Other', 'Article by Dalek'),
    snapshotNode(2, 1, 0, undefined, 'Other', 'Article by The Doctor'),
  ]);
  expect(collectModalContainedIndexes(nodes).size).toBe(0);
});

test('contains a full-screen presentation that a sheet does not geometrically cover', () => {
  const nodes = windowWith([
    ...presentationSubtree(1, 1, 0, { title: 'Article by Dalek' }),
    ...presentationSubtree(6, 1, 0, { title: 'Albums', rect: SHEET }),
  ]);
  expect([...collectModalContainedIndexes(nodes)].sort((left, right) => left - right)).toEqual([
    1, 2, 3, 4, 5,
  ]);
});
