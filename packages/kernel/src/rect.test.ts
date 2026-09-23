import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Rect } from './snapshot.ts';
import {
  containsPoint,
  isGeometricallyActionable,
  isRectVisibleInViewport,
  pickLargestRect,
} from './rect.ts';

const VIEWPORT: Rect = { x: 0, y: 0, width: 300, height: 500 };

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
