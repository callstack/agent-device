import { PNG } from './png.ts';

/**
 * Decoded-frame builders for tests that reason about pixels: a solid fill is enough to name what a
 * test claims a frame contains without shipping a PNG fixture through the repo.
 */

export type Rgba = readonly [number, number, number, number];

export const BLACK: Rgba = [0, 0, 0, 255];

export function solidPng(width: number, height: number, color: Rgba = BLACK): PNG {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = color[0];
    png.data[offset + 1] = color[1];
    png.data[offset + 2] = color[2];
    png.data[offset + 3] = color[3];
  }
  return png;
}
