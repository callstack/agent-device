import { describe, expect, test } from 'vitest';
import { BLACK, solidPng, WHITE } from './png-pixels.fixtures.ts';
import { PNG } from './png.ts';
import { drawPngGlyphText, measurePngGlyphTextHeight } from './screenshot-overlay-draw.ts';

/** One glyph column count plus the gap after it; the distance the painter moves per character. */
const GLYPH_PITCH = 6;

function countPixels(png: PNG, color: readonly number[]): number {
  let count = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (
      png.data[offset] === color[0] &&
      png.data[offset + 1] === color[1] &&
      png.data[offset + 2] === color[2] &&
      png.data[offset + 3] === color[3]
    ) {
      count += 1;
    }
  }
  return count;
}

describe('png glyph text', () => {
  test('paints the timestamp characters an elapsed-time label is built from', () => {
    for (const text of ['0', '9', ':', '.', '00:00:01.234']) {
      const png = solidPng(140, 12, BLACK);
      drawPngGlyphText(png, { x: 2, y: 2, text, color: WHITE });
      expect(countPixels(png, WHITE), text).toBeGreaterThan(0);
    }
  });

  test('scales a glyph to whole blocks so a label stays crisp', () => {
    const single = solidPng(40, 12, BLACK);
    drawPngGlyphText(single, { x: 2, y: 2, text: '1', color: WHITE });
    const doubled = solidPng(40, 20, BLACK);
    drawPngGlyphText(doubled, { x: 2, y: 2, text: '1', color: WHITE, scale: 2 });

    expect(countPixels(doubled, WHITE)).toBe(countPixels(single, WHITE) * 4);
    expect(measurePngGlyphTextHeight()).toBe(7);
    expect(measurePngGlyphTextHeight(2)).toBe(14);
  });

  test('advances past a character the table does not cover', () => {
    const blank = solidPng(40, 12, BLACK);
    drawPngGlyphText(blank, { x: 2, y: 2, text: 'z', color: WHITE });
    expect(countPixels(blank, WHITE)).toBe(0);

    const shifted = solidPng(40, 12, BLACK);
    drawPngGlyphText(shifted, { x: 2, y: 2, text: 'z1', color: WHITE });
    const aligned = solidPng(40, 12, BLACK);
    drawPngGlyphText(aligned, { x: 2 + GLYPH_PITCH, y: 2, text: '1', color: WHITE });

    expect(shifted.data.equals(aligned.data)).toBe(true);
  });

  test('clips at the image edge instead of writing past it', () => {
    const png = solidPng(4, 4, BLACK);
    expect(() =>
      drawPngGlyphText(png, { x: -3, y: -3, text: '00:00', color: WHITE, scale: 2 }),
    ).not.toThrow();
    expect(png.data.length).toBe(4 * 4 * 4);
  });
});
