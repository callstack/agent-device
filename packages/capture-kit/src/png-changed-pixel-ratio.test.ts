import { describe, expect, test } from 'vitest';
import { computePngChangedPixelRatio } from './png-changed-pixel-ratio.ts';
import { BLACK, paintPng, solidPng, WHITE } from './png-pixels.fixtures.ts';

function pixels(png: { width: number; height: number; data: Buffer }) {
  return { width: png.width, height: png.height, data: png.data };
}

describe('computePngChangedPixelRatio', () => {
  test('reports nothing moved for identical frames', () => {
    expect(
      computePngChangedPixelRatio(pixels(solidPng(4, 4, BLACK)), pixels(solidPng(4, 4, BLACK))),
    ).toEqual({ status: 'compared', changedPixelRatio: 0 });
  });

  test('counts a pixel whose blue channel alone moved', () => {
    const blue = paintPng(
      solidPng(4, 4, BLACK),
      { x: 0, y: 0, width: 1, height: 1 },
      [0, 0, 9, 255],
    );
    expect(computePngChangedPixelRatio(pixels(solidPng(4, 4, BLACK)), pixels(blue))).toEqual({
      status: 'compared',
      changedPixelRatio: 1 / 16,
    });
  });

  test('ignores alpha, which never reaches the recorded screen', () => {
    const transparent = solidPng(4, 4, BLACK);
    transparent.data[3] = 0;
    expect(computePngChangedPixelRatio(pixels(solidPng(4, 4, BLACK)), pixels(transparent))).toEqual(
      { status: 'compared', changedPixelRatio: 0 },
    );
  });

  test('counts every pixel when the whole frame moved', () => {
    expect(
      computePngChangedPixelRatio(pixels(solidPng(4, 4, BLACK)), pixels(solidPng(4, 4, WHITE))),
    ).toEqual({ status: 'compared', changedPixelRatio: 1 });
  });

  test('refuses a ratio across frames of different shapes', () => {
    expect(
      computePngChangedPixelRatio(pixels(solidPng(4, 4, BLACK)), pixels(solidPng(4, 8, BLACK))),
    ).toEqual({ status: 'dimension_mismatch' });
  });
});
