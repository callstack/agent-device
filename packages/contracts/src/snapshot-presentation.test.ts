import { expect, test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import fc from 'fast-check';
import {
  createSnapshotPresentationNode,
  foldSnapshotRect,
  serializeRegularSnapshotPresentationNode,
} from './snapshot-presentation.ts';

const rawNode: RawSnapshotNode = {
  index: 7,
  type: 'Button',
  label: 'Save',
  rect: { x: 0, y: 0, width: 100, height: 80 },
  hittable: true,
};

const rectArb = fc.record({
  x: fc.integer({ min: -500, max: 500 }),
  y: fc.integer({ min: -500, max: 500 }),
  width: fc.integer({ min: -20, max: 500 }),
  height: fc.integer({ min: -20, max: 500 }),
});

const positiveRectArb = fc.record({
  x: fc.integer({ min: -500, max: 500 }),
  y: fc.integer({ min: -500, max: 500 }),
  width: fc.integer({ min: 1, max: 500 }),
  height: fc.integer({ min: 1, max: 500 }),
});

test('the shared fold carries both viewport and ancestor clipping into effective geometry', () => {
  expect(
    foldSnapshotRect(
      rawNode.rect,
      { x: 20, y: 10, width: 50, height: 50 },
      { x: 30, y: 20, width: 100, height: 20 },
    ),
  ).toEqual({ x: 30, y: 20, width: 40, height: 20 });
});

test('regular serialization publishes effective geometry and fails closed on degenerate clips', () => {
  const presented = createSnapshotPresentationNode(rawNode, {
    x: 30,
    y: 20,
    width: 40,
    height: 20,
  });
  expect(serializeRegularSnapshotPresentationNode(presented)).toEqual({
    ...rawNode,
    rect: { x: 30, y: 20, width: 40, height: 20 },
    hittable: true,
  });

  expect(
    serializeRegularSnapshotPresentationNode(
      createSnapshotPresentationNode(rawNode, { x: 30, y: 20, width: 0, height: 20 }),
    ),
  ).toEqual({
    ...rawNode,
    rect: { x: 30, y: 20, width: 0, height: 20 },
    hittable: undefined,
  });
});

test('property: effective geometry stays inside every positive clip and never upgrades actionability', () => {
  fc.assert(
    fc.property(rectArb, positiveRectArb, positiveRectArb, (reported, viewport, ancestorClip) => {
      const effective = foldSnapshotRect(reported, viewport, ancestorClip);
      const raw = { index: 0, depth: 0, rect: reported, hittable: true as const };
      const presented = createSnapshotPresentationNode(raw, effective);
      const regular = serializeRegularSnapshotPresentationNode(presented);

      expect(presented.raw.rect).toEqual(reported);
      expect(regular.rect).toEqual(effective);
      if (effective && effective.width > 0 && effective.height > 0) {
        expect(rectContains(viewport, effective)).toBe(true);
        expect(rectContains(ancestorClip, effective)).toBe(true);
        expect(regular.hittable).toBe(true);
      } else {
        expect(regular.hittable).toBeUndefined();
      }
    }),
    { numRuns: 100 },
  );
});

function rectContains(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + Math.max(0, outer.width) &&
    inner.y + inner.height <= outer.y + Math.max(0, outer.height)
  );
}
