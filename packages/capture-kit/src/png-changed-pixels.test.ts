import { describe, expect, test } from 'vitest';
import { computePngChangedPixels } from './png-changed-pixels.ts';
import { BLACK, paintPng, type Rgba, solidPng, WHITE } from './png-pixels.fixtures.ts';

function pixels(png: { width: number; height: number; data: Buffer }) {
  return { width: png.width, height: png.height, data: png.data };
}

const NOISE: Rgba = [0, 0, 9, 255];

describe('computePngChangedPixels', () => {
  test('reports nothing moved for identical frames', () => {
    expect(
      computePngChangedPixels(pixels(solidPng(4, 4, BLACK)), pixels(solidPng(4, 4, BLACK))),
    ).toEqual({ status: 'compared', changedPixelRatio: 0, region: null });
  });

  test('counts a pixel whose blue channel alone moved', () => {
    const blue = paintPng(solidPng(4, 4, BLACK), { x: 0, y: 0, width: 1, height: 1 }, NOISE);
    expect(computePngChangedPixels(pixels(solidPng(4, 4, BLACK)), pixels(blue))).toEqual({
      status: 'compared',
      changedPixelRatio: 1 / 16,
      region: null,
    });
  });

  test('ignores alpha, which never reaches the recorded screen', () => {
    const transparent = solidPng(4, 4, BLACK);
    transparent.data[3] = 0;
    expect(computePngChangedPixels(pixels(solidPng(4, 4, BLACK)), pixels(transparent))).toEqual({
      status: 'compared',
      changedPixelRatio: 0,
      region: null,
    });
  });

  test('counts every pixel when the whole frame moved', () => {
    expect(
      computePngChangedPixels(pixels(solidPng(4, 4, BLACK)), pixels(solidPng(4, 4, WHITE))),
    ).toEqual({
      status: 'compared',
      changedPixelRatio: 1,
      region: { x: 0, y: 0, width: 4, height: 4 },
    });
  });

  test('refuses to compare frames of different shapes', () => {
    expect(
      computePngChangedPixels(pixels(solidPng(4, 4, BLACK)), pixels(solidPng(4, 8, BLACK))),
    ).toEqual({ status: 'dimension_mismatch' });
  });

  test('boxes the region that moved past the tolerance', () => {
    const moved = paintPng(solidPng(4, 4, BLACK), { x: 2, y: 1, width: 2, height: 2 }, WHITE);
    expect(computePngChangedPixels(pixels(solidPng(4, 4, BLACK)), pixels(moved))).toEqual({
      status: 'compared',
      changedPixelRatio: 4 / 16,
      region: { x: 2, y: 1, width: 2, height: 2 },
    });
  });

  test('keeps encoder noise outside the box it draws', () => {
    // The pair the sheet lives on: a real change in one corner and a shimmer elsewhere that the
    // share still counts. A box spanning both would be the whole frame, which is no answer at all.
    const noisy = paintPng(solidPng(4, 4, BLACK), { x: 0, y: 0, width: 1, height: 1 }, NOISE);
    const frame = paintPng(noisy, { x: 2, y: 2, width: 1, height: 1 }, WHITE);
    expect(computePngChangedPixels(pixels(solidPng(4, 4, BLACK)), pixels(frame))).toEqual({
      status: 'compared',
      changedPixelRatio: 2 / 16,
      region: { x: 2, y: 2, width: 1, height: 1 },
    });
  });

  test('lets a caller ask for a wider tolerance', () => {
    const blue = paintPng(solidPng(4, 4, BLACK), { x: 0, y: 0, width: 1, height: 1 }, NOISE);
    expect(computePngChangedPixels(pixels(solidPng(4, 4, BLACK)), pixels(blue), 4)).toEqual({
      status: 'compared',
      changedPixelRatio: 1 / 16,
      region: { x: 0, y: 0, width: 1, height: 1 },
    });
  });
});
