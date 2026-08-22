import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { Point, Rect } from '@agent-device/kernel/snapshot';
import { test } from 'vitest';
import {
  interactionTouchPointScenarioArb,
  PROPERTY_RUNS,
} from '../__tests__/test-utils/property-arbitraries.ts';
import { makeSnapshotState } from '../__tests__/test-utils/snapshot-builders.ts';
import { resolveInteractionTouchPoint } from './interaction-touch-point.ts';

function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function blueskyPostNodes() {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Link',
      label: 'feedItem-by-whiskers.test',
      rect: { x: 0, y: 180, width: 402, height: 520 },
      hittable: true,
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Link',
      label: "whiskers's avatar",
      rect: { x: 16, y: 196, width: 48, height: 48 },
      hittable: true,
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Mochi napping in a sunbeam #caturday',
      rect: { x: 72, y: 246, width: 300, height: 36 },
      hittable: true,
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'A kitten asleep in sunlight.',
      rect: { x: 16, y: 292, width: 370, height: 330 },
      hittable: true,
    },
    {
      index: 5,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Reply (0 replies)',
      rect: { x: 16, y: 638, width: 48, height: 44 },
      hittable: true,
    },
    {
      index: 6,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Repost (0 reposts)',
      rect: { x: 82, y: 638, width: 48, height: 44 },
      hittable: true,
    },
  ]).nodes;
}

test('chooses a parent-owned post point outside interactive descendants', () => {
  const nodes = blueskyPostNodes();

  const resolution = resolveInteractionTouchPoint(nodes, nodes[1]!);

  assert.equal(resolution.kind, 'resolved');
  if (resolution.kind !== 'resolved') return;
  assert.equal(resolution.strategy, 'parent-owned');
  assert.ok(resolution.point.y < 292, 'point should land in the post text band above the image');
  assert.notDeepEqual(resolution.point, { x: 201, y: 440 });
});

test('keeps the exact center when there are no competing interactive descendants', () => {
  const nodes = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      rect: { x: 20, y: 30, width: 80, height: 40 },
      hittable: true,
    },
  ]).nodes;

  assert.deepEqual(resolveInteractionTouchPoint(nodes, nodes[0]!), {
    kind: 'resolved',
    point: { x: 60, y: 50 },
    strategy: 'center',
  });
});

test('keeps a parent-owned center in a thin row when a child is safely off to the side', () => {
  const nodes = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Link',
      label: 'Dense row',
      rect: { x: 0, y: 0, width: 200, height: 22 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'More',
      rect: { x: 178, y: 0, width: 22, height: 22 },
      hittable: true,
    },
  ]).nodes;

  assert.deepEqual(resolveInteractionTouchPoint(nodes, nodes[0]!), {
    kind: 'resolved',
    point: { x: 100, y: 11 },
    strategy: 'parent-owned',
  });
});

test('fails closed when interactive descendants tile the parent', () => {
  const nodes = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Link',
      label: 'Card',
      rect: { x: 0, y: 0, width: 100, height: 100 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Top',
      rect: { x: 0, y: 0, width: 100, height: 50 },
      hittable: true,
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Bottom',
      rect: { x: 0, y: 50, width: 100, height: 50 },
      hittable: true,
    },
  ]).nodes;

  assert.deepEqual(resolveInteractionTouchPoint(nodes, nodes[0]!), {
    kind: 'blocked',
    competitorRefs: ['e2', 'e3'],
  });
});

test('same-rect wrapper descendants remain part of the parent touch surface', () => {
  const nodes = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Link',
      label: 'Card',
      rect: { x: 10, y: 20, width: 200, height: 80 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Pressable wrapper',
      rect: { x: 10, y: 20, width: 200, height: 80 },
      hittable: true,
    },
  ]).nodes;

  assert.deepEqual(resolveInteractionTouchPoint(nodes, nodes[0]!), {
    kind: 'resolved',
    point: { x: 110, y: 60 },
    strategy: 'center',
  });
});

test('point selection is independent of node array order', () => {
  const nodes = blueskyPostNodes();
  const shuffled = [nodes[0]!, nodes[1]!, ...nodes.slice(2).reverse()];

  assert.deepEqual(
    resolveInteractionTouchPoint(shuffled, shuffled[1]!),
    resolveInteractionTouchPoint(nodes, nodes[1]!),
  );
});

test('keeps a parent-owned point inside the supplied viewport bounds', () => {
  const nodes = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Link',
      label: 'Partially clipped card',
      rect: { x: -50, y: 20, width: 100, height: 80 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Right child',
      rect: { x: 30, y: 20, width: 20, height: 80 },
      hittable: true,
    },
  ]).nodes;

  const resolution = resolveInteractionTouchPoint(nodes, nodes[0]!, {
    bounds: [{ x: 0, y: 0, width: 100, height: 120 }],
  });

  assert.equal(resolution.kind, 'resolved');
  if (resolution.kind === 'resolved') assert.ok(resolution.point.x >= 0);
});

test('keeps rounded parent-owned points inside half-pixel viewport bounds', () => {
  const nodes = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Link',
      label: 'Thin clipped row',
      rect: { x: 37.5, y: 0, width: 2, height: 398 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Leading action',
      rect: { x: 37.5, y: 0, width: 1, height: 1 },
      hittable: true,
    },
  ]).nodes;
  const bound = { x: 37.5, y: 0, width: 1, height: 80 };

  const resolution = resolveInteractionTouchPoint(nodes, nodes[0]!, { bounds: [bound] });

  assert.equal(resolution.kind, 'resolved');
  if (resolution.kind === 'resolved') assert.ok(containsPoint(bound, resolution.point));
});

test('property: resolved parent-owned points stay inside the target and supplied bounds', () => {
  fc.assert(
    fc.property(interactionTouchPointScenarioArb, ({ nodes, target, bound }) => {
      const resolution = resolveInteractionTouchPoint(nodes, target, { bounds: [bound] });
      if (resolution.kind !== 'resolved') return;
      assert.ok(containsPoint(target.rect!, resolution.point));
      assert.ok(containsPoint(bound, resolution.point));
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test('property: resolved parent-owned points stay outside every competing descendant', () => {
  fc.assert(
    fc.property(interactionTouchPointScenarioArb, ({ nodes, target, bound, competitorRects }) => {
      const resolution = resolveInteractionTouchPoint(nodes, target, { bounds: [bound] });
      if (resolution.kind !== 'resolved') return;
      for (const competitor of competitorRects) {
        assert.equal(containsPoint(competitor, resolution.point), false);
      }
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test('property: touch-point resolution is invariant to node-array permutations', () => {
  fc.assert(
    fc.property(interactionTouchPointScenarioArb, ({ nodes, permutedNodes, target, bound }) => {
      assert.deepEqual(
        resolveInteractionTouchPoint(permutedNodes, target, { bounds: [bound] }),
        resolveInteractionTouchPoint(nodes, target, { bounds: [bound] }),
      );
    }),
    { numRuns: PROPERTY_RUNS },
  );
});
