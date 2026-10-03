import { describe, expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { BLACK, solidPng, WHITE } from '../png-pixels.fixtures.ts';
import { decodePng } from '../png.ts';
import { CONTACT_SHEET_FRAME_WIDTH } from './contact-sheet-plan.ts';
import {
  MIN_CONTACT_SHEET_CELL_WIDTH,
  formatContactSheetTimestamp,
  renderContactSheet,
} from './contact-sheet-render.ts';
import type { ContactSheetCell } from './contact-sheet-selection.ts';

function cell(timeMs: number, width = 20, height = 10): ContactSheetCell {
  return { timeMs, changedPixelRatio: 1, image: solidPng(width, height, BLACK) };
}

function countPixels(png: ReturnType<typeof decodePng>, color: readonly number[]): number {
  let count = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (
      png.data[offset] === color[0] &&
      png.data[offset + 1] === color[1] &&
      png.data[offset + 2] === color[2]
    ) {
      count += 1;
    }
  }
  return count;
}

describe('formatContactSheetTimestamp', () => {
  test('prints elapsed time the glyph table can spell', () => {
    expect(formatContactSheetTimestamp(0)).toBe('00:00:00.000');
    expect(formatContactSheetTimestamp(1_234)).toBe('00:00:01.234');
    expect(formatContactSheetTimestamp(3_723_456)).toBe('01:02:03.456');
    expect(formatContactSheetTimestamp(3_600_000)).toBe('01:00:00.000');
  });
});

describe('renderContactSheet', () => {
  test('encodes one grid whose bytes carry the reported size', () => {
    const sheet = renderContactSheet({
      cells: [cell(0), cell(250)],
      maxPixels: 20_000_000,
    });

    const decoded = decodePng(sheet.bytes, 'contact sheet');
    expect([decoded.width, decoded.height]).toEqual([sheet.width, sheet.height]);
    // Two cells in one row of four columns: padding, two cells, and the gap between them.
    expect(sheet.width).toBe(CONTACT_SHEET_FRAME_WIDTH * 2 + 8 * 3);
  });

  test('burns a timestamp label above every cell', () => {
    const sheet = renderContactSheet({
      cells: [cell(0), cell(250), cell(500)],
      maxPixels: 20_000_000,
    });

    const decoded = decodePng(sheet.bytes, 'contact sheet');
    expect(countPixels(decoded, WHITE)).toBeGreaterThan(0);
  });

  test('shrinks cells to stay inside the caller’s pixel budget', () => {
    const sheet = renderContactSheet({
      cells: Array.from({ length: 12 }, (_, index) => cell(index * 250, 80, 40)),
      maxPixels: 250_000,
    });

    expect(sheet.width * sheet.height).toBeLessThanOrEqual(250_000);
    expect(sheet.cellWidth).toBeLessThan(CONTACT_SHEET_FRAME_WIDTH);
    expect(sheet.cellWidth).toBeGreaterThanOrEqual(MIN_CONTACT_SHEET_CELL_WIDTH);
  });

  test('refuses rather than printing a sheet nobody can read', () => {
    expect(() =>
      renderContactSheet({ cells: [cell(0, 40, 400), cell(250, 40, 400)], maxPixels: 4_000 }),
    ).toThrow(/maxImagePixels/);
  });

  test('refuses a sheet with no cells instead of writing an empty page', () => {
    try {
      renderContactSheet({ cells: [], maxPixels: 20_000_000 });
      throw new Error('expected renderContactSheet to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
    }
  });
});
