import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Rect } from './snapshot.ts';
import {
  containsPoint,
  isGeometricallyActionable,
  isPositiveFiniteRect,
  isRectVisibleInViewport,
  pickLargestRect,
} from './rect.ts';

const VIEWPORT: Rect = { x: 0, y: 0, width: 300, height: 500 };

/** `CGRectInfinite` spelled in the doubles Apple spells it with: what a failed read crosses a wire in. */
const CG_RECT_INFINITE: Rect = {
  x: -Number.MAX_VALUE / 2,
  y: -Number.MAX_VALUE / 2,
  width: Number.MAX_VALUE,
  height: Number.MAX_VALUE,
};

test('isPositiveFiniteRect refuses the three boxes its numeric twins cannot measure (#2891)', () => {
  assert.equal(isPositiveFiniteRect({ x: 0, y: 0, width: 390, height: 844 }), true);
  assert.equal(isPositiveFiniteRect(CG_RECT_INFINITE), false, 'the Apple no-box sentinel');
  assert.equal(
    isPositiveFiniteRect({ x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 }),
    false,
    'finite components that overflow their own right edge',
  );
  assert.equal(
    isPositiveFiniteRect({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 }),
    false,
  );
  assert.equal(isPositiveFiniteRect({ x: 0, y: 0, width: 10, height: Number.NaN }), false);
  assert.equal(isPositiveFiniteRect({ x: 0, y: 0, width: 0, height: 10 }), false);
  assert.equal(isPositiveFiniteRect({ x: 0, y: 0, width: -10, height: 10 }), false);
  assert.equal(isPositiveFiniteRect(undefined), false);
});

/**
 * Non-vacuity for the sentinel: every component and every extent of it is finite, so the guard's
 * identity refusal is the only thing standing between a failed viewport read and a box that
 * contains every node center on the screen.
 */
test('the sentinel would survive any check that only looks at components and extents', () => {
  const components = [
    CG_RECT_INFINITE.x,
    CG_RECT_INFINITE.y,
    CG_RECT_INFINITE.width,
    CG_RECT_INFINITE.height,
  ];
  assert.ok(components.every(Number.isFinite));
  assert.ok(Number.isFinite(CG_RECT_INFINITE.x + CG_RECT_INFINITE.width));
  assert.ok(Number.isFinite(CG_RECT_INFINITE.y + CG_RECT_INFINITE.height));
  assert.equal(CG_RECT_INFINITE.x + CG_RECT_INFINITE.width / 2, 0, 'its center is (0, 0)');
  assert.equal(
    isPositiveFiniteRect({ ...CG_RECT_INFINITE, height: 123 }),
    true,
    'one byte off is a real box',
  );
});

test('containsPoint is inclusive on every edge and requires all four bounds', () => {
  assert.equal(containsPoint(VIEWPORT, 0, 0), true);
  assert.equal(containsPoint(VIEWPORT, 300, 500), true);
  assert.equal(containsPoint(VIEWPORT, -1, 0), false);
  assert.equal(containsPoint(VIEWPORT, 0, 501), false);
});

test('isRectVisibleInViewport counts inclusive edge contact on both axes as visible', () => {
  assert.equal(isRectVisibleInViewport({ x: 20, y: 20, width: 40, height: 40 }, VIEWPORT), true);
  assert.equal(isRectVisibleInViewport({ x: 300, y: 0, width: 40, height: 40 }, VIEWPORT), true);
  assert.equal(isRectVisibleInViewport({ x: 301, y: 0, width: 40, height: 40 }, VIEWPORT), false);
  assert.equal(isRectVisibleInViewport({ x: 0, y: 501, width: 40, height: 40 }, VIEWPORT), false);
});

test('pickLargestRect selects by area and returns null for an empty list', () => {
  assert.deepEqual(pickLargestRect([{ x: 0, y: 0, width: 2, height: 2 }, VIEWPORT]), VIEWPORT);
  assert.equal(pickLargestRect([]), null);
});

// These rows are the TypeScript twin of the runner's Swift `SnapshotGeometry.isGeometricallyActionable`
// (asserted over randomized rects by the snapshot differential and over authored rects by
// CoordinateSpaceTests.swift). They pin it so the host AX bridge cannot drift from the XCTest runner.
test('isGeometricallyActionable matches the Swift runner predicate', () => {
  assert.equal(
    isGeometricallyActionable(true, { x: 10, y: 10, width: 40, height: 40 }, VIEWPORT),
    true,
  );
  // Enabled but centered off-screen, or zero/negative/absent, is never actionable.
  assert.equal(
    isGeometricallyActionable(true, { x: 320, y: 10, width: 40, height: 40 }, VIEWPORT),
    false,
  );
  assert.equal(
    isGeometricallyActionable(true, { x: 10, y: 600, width: 40, height: 40 }, VIEWPORT),
    false,
  );
  assert.equal(
    isGeometricallyActionable(true, { x: 10, y: 10, width: 0, height: 40 }, VIEWPORT),
    false,
  );
  assert.equal(isGeometricallyActionable(true, undefined, VIEWPORT), false);
  // A disabled node with a centred frame is not actionable.
  assert.equal(
    isGeometricallyActionable(false, { x: 10, y: 10, width: 40, height: 40 }, VIEWPORT),
    false,
  );
  // CGRect.contains is half-open: the top/left edge counts, the right/bottom edge does not — the
  // divergence the shared `containsPoint` (inclusive) would otherwise hide from a `hittable:` selector.
  const topCentered: Rect = { x: 0, y: 0, width: 2, height: 2 };
  assert.equal(
    isGeometricallyActionable(true, topCentered, VIEWPORT),
    true,
    'center at the origin counts',
  );
  assert.equal(
    containsPoint(VIEWPORT, 300, 250),
    true,
    'containsPoint stays inclusive on the right edge',
  );
  assert.equal(
    isGeometricallyActionable(true, { x: 299, y: 249, width: 2, height: 2 }, VIEWPORT),
    false,
    'a center on the right edge is not hittable',
  );
  assert.equal(
    isGeometricallyActionable(true, { x: 149, y: 499, width: 2, height: 2 }, VIEWPORT),
    false,
    'a center on the bottom edge is not hittable',
  );
});
