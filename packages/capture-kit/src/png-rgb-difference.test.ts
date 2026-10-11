import { expect, test } from 'vitest';
import { computePngRgbDifference, type PngRgbImage } from './png-rgb-difference.ts';

function image(width: number, height: number, data: number[]): PngRgbImage {
  return { width, height, data: Uint8Array.from(data) };
}

test('computePngRgbDifference answers 0 for pixel-identical images and ignores alpha', () => {
  const first = image(2, 1, [10, 20, 30, 0, 200, 100, 50, 255]);
  const second = image(2, 1, [10, 20, 30, 255, 200, 100, 50, 0]);

  expect(computePngRgbDifference(first, second)).toEqual({
    status: 'compared',
    differencePercent: 0,
    first: { width: 2, height: 1, dataLength: 8 },
    second: { width: 2, height: 1, dataLength: 8 },
  });
});

test('computePngRgbDifference normalizes the absolute RGB difference over 3 x 255 per pixel', () => {
  // One pixel differs by 255 on one channel: 100 * 255 / (3 * 255 * 1) = 33 1/3 %.
  const black = image(1, 1, [0, 0, 0, 255]);
  const red = image(1, 1, [255, 0, 0, 255]);
  const result = computePngRgbDifference(black, red);

  expect(result.status).toBe('compared');
  if (result.status !== 'compared') return;
  expect(result.differencePercent).toBeCloseTo(100 / 3, 10);
});

test('computePngRgbDifference reports a dimension mismatch without touching pixel data', () => {
  const result = computePngRgbDifference(
    image(2, 1, [0, 0, 0, 255, 0, 0, 0, 255]),
    image(1, 2, [0, 0, 0, 255, 0, 0, 0, 255]),
  );

  expect(result).toEqual({
    status: 'dimension_mismatch',
    first: { width: 2, height: 1, dataLength: 8 },
    second: { width: 1, height: 2, dataLength: 8 },
  });
});

test('computePngRgbDifference reports mismatched RGBA buffer lengths', () => {
  // Same declared dimensions, but one side carries fewer RGBA rows than the other.
  const result = computePngRgbDifference(
    image(2, 1, [0, 0, 0, 255]),
    image(2, 1, [0, 0, 0, 255, 0, 0, 0, 255]),
  );

  expect(result).toEqual({
    status: 'data_length_mismatch',
    first: { width: 2, height: 1, dataLength: 4 },
    second: { width: 2, height: 1, dataLength: 8 },
  });
});

test('computePngRgbDifference refuses a buffer that disagrees with its own dimensions', () => {
  // Equal lengths on both sides, but one RGBA row cannot cover a 2 x 1 image.
  const short = image(2, 1, [0, 0, 0, 255]);
  expect(computePngRgbDifference(short, image(2, 1, [0, 0, 0, 255]))).toEqual({
    status: 'data_length_mismatch',
    first: { width: 2, height: 1, dataLength: 4 },
    second: { width: 2, height: 1, dataLength: 4 },
  });
});
