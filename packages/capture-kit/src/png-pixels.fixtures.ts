import { PNG } from './png.ts';
import { setPngPixel, type PngGlyphColor } from './screenshot-overlay-draw.ts';

/**
 * Decoded-frame builders for tests that reason about pixels: a solid fill and one painted rectangle
 * name exactly what a test claims changed between two frames.
 */

export type Rgba = PngGlyphColor;
export type Rectangle = Readonly<{ x: number; y: number; width: number; height: number }>;

export const BLACK: Rgba = [0, 0, 0, 255];
export const WHITE: Rgba = [255, 255, 255, 255];
export const RED: Rgba = [255, 0, 0, 255];

export function solidPng(width: number, height: number, color: Rgba = BLACK): PNG {
  return fillPng(new PNG({ width, height }), () => true, color);
}

/** Paints one rectangle of `color` onto a copy of `source`, leaving the source untouched. */
export function paintPng(source: PNG, rectangle: Rectangle, color: Rgba): PNG {
  const copy = solidPng(source.width, source.height);
  source.data.copy(copy.data);
  const inside = (column: number, row: number) =>
    column >= rectangle.x &&
    column < rectangle.x + rectangle.width &&
    row >= rectangle.y &&
    row < rectangle.y + rectangle.height;
  return fillPng(copy, inside, color);
}

function fillPng(png: PNG, paint: (column: number, row: number) => boolean, color: Rgba): PNG {
  for (let row = 0; row < png.height; row += 1) {
    for (let column = 0; column < png.width; column += 1) {
      if (paint(column, row)) setPngPixel(png, column, row, color);
    }
  }
  return png;
}
