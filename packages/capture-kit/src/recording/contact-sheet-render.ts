import { CONTACT_SHEET_PIXEL_BUDGET_REASON } from './contact-sheet-report.ts';
import { AppError } from '@agent-device/kernel/errors';
import { encodePngPixels } from '../png-encode.ts';
import { PNG } from '../png.ts';
import { resizePngBox } from '../png-resize.ts';
import {
  drawPngGlyphText,
  measurePngGlyphTextHeight,
  setPngPixel,
  type PngGlyphColor,
} from '../screenshot-overlay-draw.ts';
import { CONTACT_SHEET_FRAME_WIDTH } from './contact-sheet-plan.ts';
import type { ContactSheetCell } from './contact-sheet-selection.ts';

/** Cells per row. Four keeps a portrait phone frame readable without a canvas wider than a screen. */
const CONTACT_SHEET_COLUMNS = 4;
/** Narrowest a cell may shrink to before the sheet refuses rather than print unreadable frames. */
export const MIN_CONTACT_SHEET_CELL_WIDTH = 160;
/**
 * Cell widths tried, widest first. A cell never grows past the width frames were decoded at, and it
 * shrinks in readable steps before the sheet refuses.
 */
const LAYOUT_CELL_WIDTHS = [
  CONTACT_SHEET_FRAME_WIDTH,
  320,
  280,
  240,
  200,
  MIN_CONTACT_SHEET_CELL_WIDTH,
] as const;

const SHEET_PADDING = 8;
const CELL_GAP = 8;
const LABEL_INSET = 4;
const LABEL_SCALE = 2;
const LABEL_COLOR = [255, 255, 255, 255] as const;
const SHEET_BACKGROUND = [17, 24, 39, 255] as const;
const LABEL_HEIGHT = measurePngGlyphTextHeight(LABEL_SCALE) + LABEL_INSET * 2;

export type ContactSheetRenderInput = Readonly<{
  cells: readonly ContactSheetCell[];
  maxPixels: number;
}>;

export type ContactSheetRenderResult = Readonly<{
  bytes: Buffer;
  width: number;
  height: number;
  cellWidth: number;
}>;

/** Lays the kept cells out in one row-major grid and encodes it as PNG. */
export function renderContactSheet(input: ContactSheetRenderInput): ContactSheetRenderResult {
  const { cells } = input;
  if (cells.length === 0) {
    throw new AppError('COMMAND_FAILED', 'Contact sheet has no cells to render');
  }

  const aspect = cells[0]!.image.height / Math.max(1, cells[0]!.image.width);
  const layout = fitLayout(aspect, cells.length, input);
  const canvas = createCanvas(layout.width, layout.height, SHEET_BACKGROUND);

  cells.forEach((cell, index) => {
    const column = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    drawCell(
      canvas,
      SHEET_PADDING + column * (layout.cellWidth + CELL_GAP),
      SHEET_PADDING + row * (LABEL_HEIGHT + layout.cellHeight + CELL_GAP),
      cell,
      layout.cellWidth,
      layout.cellHeight,
    );
  });

  return {
    bytes: encodePngPixels(canvas.data, layout.width, layout.height, 4),
    width: layout.width,
    height: layout.height,
    cellWidth: layout.cellWidth,
  };
}

function drawCell(
  canvas: PNG,
  x: number,
  y: number,
  cell: ContactSheetCell,
  cellWidth: number,
  cellHeight: number,
): void {
  drawPngGlyphText(canvas, {
    x: x + LABEL_INSET,
    y: y + LABEL_INSET,
    text: formatContactSheetTimestamp(cell.timeMs),
    color: LABEL_COLOR,
    scale: LABEL_SCALE,
  });
  blit(canvas, resizePngBox(toPng(cell.image), cellWidth, cellHeight), x, y + LABEL_HEIGHT);
}

type ContactSheetLayout = Readonly<{
  width: number;
  height: number;
  columns: number;
  cellWidth: number;
  cellHeight: number;
}>;

/**
 * Sizes the grid so it fits the caller's pixel budget.
 *
 * A cell shrinks before a sheet refuses: an over-budget clip is ordinary (a tall iPad recording
 * with many changes), and re-laying the same cells out at a smaller cell is always available.
 */
function fitLayout(
  aspect: number,
  cellCount: number,
  input: ContactSheetRenderInput,
): ContactSheetLayout {
  const fitted = fitToBudget(aspect, cellCount, input.maxPixels);
  if (fitted) return fitted;
  const smallest = layoutAt(aspect, cellCount, MIN_CONTACT_SHEET_CELL_WIDTH);
  throw new AppError(
    'COMMAND_FAILED',
    `Contact sheet would be ${smallest.width * smallest.height} pixels, above the configured maxImagePixels limit of ${input.maxPixels}`,
    {
      reason: CONTACT_SHEET_PIXEL_BUDGET_REASON,
      cellCount: input.cells.length,
      maxPixels: input.maxPixels,
      hint: 'Shorten the recording or raise the command policy maxImagePixels limit.',
    },
  );
}

/**
 * Walks the cell-width ladder until the grid fits, because the label strip does not shrink with the
 * cell and a single proportional guess can land over budget. The ladder is finite and strictly
 * descending, so the narrowest readable cell is always the last thing tried.
 */
function fitToBudget(
  aspect: number,
  cellCount: number,
  budget: number,
): ContactSheetLayout | undefined {
  for (const cellWidth of LAYOUT_CELL_WIDTHS) {
    const layout = layoutAt(aspect, cellCount, cellWidth);
    if (layout.width * layout.height <= budget) return layout;
  }
  return undefined;
}

function layoutAt(aspect: number, cellCount: number, cellWidth: number): ContactSheetLayout {
  const columns = Math.min(CONTACT_SHEET_COLUMNS, cellCount);
  const rows = Math.ceil(cellCount / columns);
  const cellHeight = Math.max(1, Math.round(cellWidth * aspect));
  return {
    columns,
    cellWidth,
    cellHeight,
    width: SHEET_PADDING * 2 + columns * cellWidth + (columns - 1) * CELL_GAP,
    height: SHEET_PADDING * 2 + rows * (LABEL_HEIGHT + cellHeight) + (rows - 1) * CELL_GAP,
  };
}

function createCanvas(width: number, height: number, color: PngGlyphColor): PNG {
  const canvas = new PNG({ width, height });
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      setPngPixel(canvas, column, row, color);
    }
  }
  return canvas;
}

function blit(canvas: PNG, source: PNG, x: number, y: number): void {
  for (let row = 0; row < source.height; row += 1) {
    for (let column = 0; column < source.width; column += 1) {
      const sourceOffset = (row * source.width + column) * 4;
      setPngPixel(canvas, x + column, y + row, [
        source.data[sourceOffset]!,
        source.data[sourceOffset + 1]!,
        source.data[sourceOffset + 2]!,
        source.data[sourceOffset + 3]!,
      ]);
    }
  }
}

function toPng(image: ContactSheetCell['image']): PNG {
  const png = new PNG({ width: image.width, height: image.height });
  Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(png.data);
  return png;
}

/** Elapsed time from the clip start as `HH:MM:SS.mmm`, the shape the glyph table spells. */
export function formatContactSheetTimestamp(timeMs: number): string {
  const wholeSeconds = Math.floor(timeMs / 1000);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  const milliseconds = Math.floor(timeMs % 1000);
  const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
  return `${clock}.${String(milliseconds).padStart(3, '0')}`;
}
