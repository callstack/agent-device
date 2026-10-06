import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Rect } from './snapshot.ts';
import {
  containsPoint,
  isGeometricallyActionable,
  isPositiveFiniteRect,
  isRectVisibleInViewport,
  pickLargestRect,
  readSnapshotViewportSize,
  snapshotViewportSizeFrom,
  unionRects,
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

// #3182: the viewport a response publishes has exactly one construction path and exactly one wire
// re-read, and both answer a box they cannot accept with absence. A zero the producer answered with
// has to become "unknown", never a claim that the screen has no width.
test('snapshotViewportSizeFrom publishes only a box the rect guard accepts (#3182)', () => {
  assert.deepEqual(snapshotViewportSizeFrom({ x: 12, y: -40, width: 390, height: 844 }), {
    width: 390,
    height: 844,
  });
  assert.equal(snapshotViewportSizeFrom(undefined), undefined, 'a producer that read nothing');
  assert.equal(
    snapshotViewportSizeFrom({ x: 0, y: 0, width: 0, height: 844 }),
    undefined,
    'a zero width is unknown, never a screen of no size',
  );
  assert.equal(
    snapshotViewportSizeFrom({ x: 0, y: 0, width: Number.NaN, height: 844 }),
    undefined,
    'a non-finite extent',
  );
  assert.equal(snapshotViewportSizeFrom(CG_RECT_INFINITE), undefined, 'the failed-read sentinel');
  // A viewport carries no origin, so the producer that hands over the box it still holds after a
  // refused read arrives with plausible coordinates beside the sentinel's extents. The extents alone
  // have to refuse it, or the largest number on the wire becomes the screen (#2891).
  assert.equal(
    snapshotViewportSizeFrom({ x: 0, y: 0, width: Number.MAX_VALUE, height: Number.MAX_VALUE }),
    undefined,
    'failed-read extents beside a plausible origin',
  );
  assert.equal(
    snapshotViewportSizeFrom({ x: 0, y: 0, width: 390, height: Number.MAX_VALUE }),
    undefined,
    'one failed-read extent',
  );
});

test('readSnapshotViewportSize accepts only a guard-approved pair from a wire payload (#3182)', () => {
  assert.deepEqual(readSnapshotViewportSize({ width: 1080, height: 2400 }), {
    width: 1080,
    height: 2400,
  });
  for (const unusable of [
    undefined,
    null,
    'screen',
    [],
    {},
    { width: 1080 },
    { width: '1080', height: 2400 },
    { width: 0, height: 2400 },
    { width: 1080, height: -1 },
    { width: Number.NaN, height: 2400 },
  ]) {
    assert.equal(readSnapshotViewportSize(unusable), undefined, String(unusable));
  }
  // A producer shipping the failed-read box whole ships the sentinel origin beside maximal extents;
  // an origin on the wire is inspected, not flattened to (0, 0).
  assert.equal(
    readSnapshotViewportSize({ ...CG_RECT_INFINITE }),
    undefined,
    'the infinite sentinel with its origin',
  );
  // The published shape has no origin at all, so the ordinary broken payload is the originless one:
  // the extents have to be enough to recognise a failed read, or `x ?? 0` would mint the largest
  // finite box on the wire as the screen every rect is measured in.
  assert.equal(
    readSnapshotViewportSize({ width: Number.MAX_VALUE, height: Number.MAX_VALUE }),
    undefined,
    'failed-read extents with no origin',
  );
  assert.equal(
    readSnapshotViewportSize({ width: 390, height: Number.MAX_VALUE }),
    undefined,
    'one failed-read extent',
  );
  assert.equal(readSnapshotViewportSize({ width: 1, height: 1, x: '0' }), undefined);
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

test('unionRects spans every rect and refuses an empty list', () => {
  assert.deepEqual(
    unionRects([
      { x: 10, y: 40, width: 20, height: 10 },
      { x: 0, y: 60, width: 5, height: 30 },
    ]),
    { x: 0, y: 40, width: 30, height: 50 },
  );
  assert.throws(() => unionRects([]), /at least one rect/);
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
