import { describe, expect, test } from 'vitest';
import { paintPng, type Rgba, RED, solidPng } from '../png-pixels.fixtures.ts';
import {
  MAX_CONTACT_SHEET_CELLS,
  selectContactSheetCells,
  type ContactSheetSample,
} from './contact-sheet-selection.ts';

const FRAME_SIZE = 10;

function sample(timeMs: number, changedPixels: number, offset = 0): ContactSheetSample {
  return {
    timeMs,
    image: paintPng(
      solidPng(FRAME_SIZE, FRAME_SIZE),
      { x: offset, y: 0, width: changedPixels, height: 1 },
      RED,
    ),
  };
}

/** A change encoder noise can produce: visible to a pixel-exact share, invisible to a box. */
const NOISE: Rgba = [0, 0, 9, 255];

function noiseSample(timeMs: number, changedPixels: number): ContactSheetSample {
  return {
    timeMs,
    image: paintPng(
      solidPng(FRAME_SIZE, FRAME_SIZE),
      { x: 0, y: 0, width: changedPixels, height: 1 },
      NOISE,
    ),
  };
}

function distinctSample(index: number): ContactSheetSample {
  // Frames of a different shape always count as fully changed, which keeps this fixture honest
  // without asking it to invent pixels a video decoder would have had to produce.
  return { timeMs: index * 100, image: solidPng(FRAME_SIZE + index, FRAME_SIZE) };
}

describe('selectContactSheetCells', () => {
  test('returns nothing for no samples', () => {
    expect(selectContactSheetCells([])).toEqual({ cells: [], keptCellCount: 0, thinned: false });
  });

  test('keeps the only frame it was given', () => {
    const selection = selectContactSheetCells([sample(0, 0)]);

    expect(selection.cells).toHaveLength(1);
    expect(selection.cells[0]).toMatchObject({ timeMs: 0, changedPixelRatio: 1 });
    expect(selection.thinned).toBe(false);
  });

  test('ends with the final frame even when nothing visibly moved', () => {
    const selection = selectContactSheetCells([sample(0, 0), sample(250, 0), sample(500, 0)], 0.04);

    expect(selection.cells.map((cell) => cell.timeMs)).toEqual([0, 500]);
    expect(selection.cells.at(-1)?.changedPixelRatio).toBe(0);
  });

  test('measures against the last kept cell so small changes add up', () => {
    const selection = selectContactSheetCells(
      [
        sample(0, 0),
        // 1% of the frame: too small on its own, and it does not become the baseline.
        sample(250, 1),
        // 10% of the frame, but only 9% against the previous sample.
        sample(500, FRAME_SIZE),
      ],
      0.1,
    );

    expect(selection.cells.map((cell) => cell.timeMs)).toEqual([0, 500]);
    expect(selection.cells[1]?.changedPixelRatio).toBeCloseTo(0.1, 10);
  });

  test('reports where a kept cell moved', () => {
    const selection = selectContactSheetCells([sample(0, 0), sample(250, FRAME_SIZE)], 0.1);

    expect(selection.cells[1]?.changedRegion).toEqual({ x: 0, y: 0, width: 10, height: 1 });
  });

  test('reports no region for the opening cell, which nothing preceded', () => {
    const selection = selectContactSheetCells([sample(0, 0), sample(250, FRAME_SIZE)], 0.1);

    expect(selection.cells[0]?.changedRegion).toBeNull();
  });

  test('keeps a noise-only frame without claiming a region it cannot point at', () => {
    const selection = selectContactSheetCells([sample(0, 0), noiseSample(250, FRAME_SIZE)], 0.01);
    const kept = selection.cells[1];

    expect(kept?.changedPixelRatio).toBeCloseTo(0.1, 10);
    expect(kept?.changedRegion).toBeNull();
  });

  test('keeps a frame whose shape changed', () => {
    const selection = selectContactSheetCells(
      [sample(0, 0), { timeMs: 250, image: solidPng(20, FRAME_SIZE) }],
      0.5,
    );

    expect(selection.cells.map((cell) => cell.timeMs)).toEqual([0, 250]);
    expect(selection.cells[1]?.changedPixelRatio).toBe(1);
  });

  test('thins evenly across the kept sequence and keeps both ends', () => {
    const samples = Array.from({ length: 30 }, (_, index) => distinctSample(index));

    const selection = selectContactSheetCells(samples, 0.04, 4);

    expect(selection.keptCellCount).toBe(30);
    expect(selection.thinned).toBe(true);
    expect(selection.cells).toHaveLength(4);
    expect(selection.cells[0]?.timeMs).toBe(0);
    expect(selection.cells.at(-1)?.timeMs).toBe(2_900);
    const times = selection.cells.map((cell) => cell.timeMs);
    expect(new Set(times).size).toBe(times.length);
  });

  test('prints every kept cell while the count stays under the sheet cap', () => {
    const samples = Array.from({ length: MAX_CONTACT_SHEET_CELLS }, (_, index) =>
      distinctSample(index),
    );

    const selection = selectContactSheetCells(samples);

    expect(selection.thinned).toBe(false);
    expect(selection.cells).toHaveLength(MAX_CONTACT_SHEET_CELLS);
  });
});
