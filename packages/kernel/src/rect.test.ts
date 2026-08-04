import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Rect } from './snapshot.ts';
import { containsPoint, isRectVisibleInViewport, pickLargestRect } from './rect.ts';

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
