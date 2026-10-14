import { expect, test } from 'vitest';
import {
  areCapturedRectsAtSamePosition,
  interiorCoordinate,
  pointInsideRect,
} from './rect-center.ts';

test('interiorCoordinate preserves one-pixel edge controls', () => {
  expect(interiorCoordinate(0, 1)).toBe(0);
});

test('pointInsideRect clamps center point inside the rect bounds', () => {
  expect(pointInsideRect({ x: 0.2, y: 10.2, width: 10, height: 5 })).toEqual({
    x: 5,
    y: 13,
  });
});

const CAPTURED = { x: 100, y: 200, width: 120, height: 44 };

function shifted(over: Partial<typeof CAPTURED> = {}) {
  return { ...CAPTURED, ...over };
}

test('two captures at the same rect report one position', () => {
  expect(areCapturedRectsAtSamePosition(CAPTURED, shifted())).toBe(true);
});

test('a one-pixel shift is capture rounding, not motion', () => {
  expect(areCapturedRectsAtSamePosition(CAPTURED, shifted({ x: CAPTURED.x + 1 }))).toBe(true);
  expect(areCapturedRectsAtSamePosition(CAPTURED, shifted({ height: CAPTURED.height + 1 }))).toBe(
    true,
  );
});

test('the band is one pixel on every axis, and one axis is enough to move', () => {
  // The slide-in case from the #3471 repro (ADB Android): a translate animation keeps width and
  // height constant, so only one axis says the target moved.
  expect(areCapturedRectsAtSamePosition(CAPTURED, shifted({ x: CAPTURED.x + 2 }))).toBe(false);
  expect(areCapturedRectsAtSamePosition(CAPTURED, shifted({ y: CAPTURED.y + 2 }))).toBe(false);
  expect(areCapturedRectsAtSamePosition(CAPTURED, shifted({ width: CAPTURED.width + 2 }))).toBe(
    false,
  );
  expect(areCapturedRectsAtSamePosition(CAPTURED, shifted({ height: CAPTURED.height + 2 }))).toBe(
    false,
  );
});

test('a rect that reports no position never reports one position with another', () => {
  // Absence is the surface having changed under the point, so it can never be the observation that
  // certifies rest, for either the moving-target gate or the post-gesture no-effect claim.
  expect(areCapturedRectsAtSamePosition(CAPTURED, undefined)).toBe(false);
  expect(areCapturedRectsAtSamePosition(undefined, CAPTURED)).toBe(false);
  expect(areCapturedRectsAtSamePosition(undefined, undefined)).toBe(false);
  expect(areCapturedRectsAtSamePosition(CAPTURED, shifted({ width: Number.NaN }))).toBe(false);
  expect(areCapturedRectsAtSamePosition(CAPTURED, shifted({ width: -1 }))).toBe(false);
});

test('the comparison is symmetric', () => {
  expect(areCapturedRectsAtSamePosition(shifted({ y: 201 }), CAPTURED)).toBe(
    areCapturedRectsAtSamePosition(CAPTURED, shifted({ y: 201 })),
  );
  expect(areCapturedRectsAtSamePosition(shifted({ y: 202 }), CAPTURED)).toBe(
    areCapturedRectsAtSamePosition(CAPTURED, shifted({ y: 202 })),
  );
});
