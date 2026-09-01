import { expect, test } from 'vitest';
import { interiorCoordinate, pointInsideRect } from './rect-center.ts';

test('interiorCoordinate preserves one-pixel edge controls', () => {
  expect(interiorCoordinate(0, 1)).toBe(0);
});

test('pointInsideRect clamps center point inside the rect bounds', () => {
  expect(pointInsideRect({ x: 0.2, y: 10.2, width: 10, height: 5 })).toEqual({
    x: 5,
    y: 13,
  });
});
