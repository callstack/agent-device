import type { Rect, ScreenshotOverlayRef } from '@agent-device/kernel/snapshot';
import type { PNG } from './png.ts';
import { clamp } from './screenshot-overlay-rects.ts';

/**
 * Rasterizing onto a decoded PNG: border, badge, and the elapsed-time labels other annotators paint.
 * Which node earns a ref, and where its rect lands, is `screenshot-overlay.ts`'s question — this
 * module only paints what it is handed.
 */
const BORDER_COLOR: PngGlyphColor = [255, 59, 48, 255];
const BADGE_COLOR: PngGlyphColor = [255, 214, 10, 255];
const TEXT_COLOR: PngGlyphColor = [0, 0, 0, 255];
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_SPACING = 1;
const GLYPH_PITCH = GLYPH_WIDTH + GLYPH_SPACING;
const BADGE_PADDING_X = 3;
const BADGE_PADDING_Y = 2;
const BADGE_MARGIN = 2;
const BORDER_THICKNESS = 2;

/**
 * The bitmap glyph table every capture annotator paints with. It covers the characters those labels
 * are built from — the `e` ref prefix, digits, and the separator and decimal point of an elapsed
 * time — and nothing else, so an unsupported character paints as blank rather than inventing a
 * shape nobody reviewed.
 */
const FONT: Record<string, readonly string[]> = {
  e: ['01110', '10000', '11110', '10000', '10000', '10001', '01110'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
};

/** One RGBA pixel, in the order PNG rows store them. */
export type PngGlyphColor = readonly [number, number, number, number];

export function drawOverlayRef(png: PNG, overlayRef: ScreenshotOverlayRef): void {
  drawRectBorder(png, overlayRef.overlayRect, BORDER_COLOR, BORDER_THICKNESS);
  drawBadge(png, overlayRef.overlayRect, overlayRef.ref);
}

/** Width the painted text occupies at scale 1, with no trailing inter-character gap. */
function measurePngGlyphTextWidth(text: string): number {
  if (text === '') return 0;
  return text.length * GLYPH_PITCH - GLYPH_SPACING;
}

export function measurePngGlyphTextHeight(scale = 1): number {
  return GLYPH_HEIGHT * scale;
}

/**
 * Paints `text` at `x, y`, each glyph block `scale` pixels wide and tall, clipping at the image
 * edge. A character the table does not cover still advances the cursor, so a partially supported
 * label keeps its layout.
 */
export function drawPngGlyphText(
  png: PNG,
  input: Readonly<{
    x: number;
    y: number;
    text: string;
    color: PngGlyphColor;
    scale?: number;
  }>,
): void {
  const scale = input.scale ?? 1;
  let cursorX = input.x;
  for (const character of input.text.toLowerCase()) {
    const glyph = FONT[character];
    if (glyph) drawGlyph(png, glyph, cursorX, input.y, scale, input.color);
    cursorX += GLYPH_PITCH * scale;
  }
}

function drawGlyph(
  png: PNG,
  glyph: readonly string[],
  x: number,
  y: number,
  scale: number,
  color: PngGlyphColor,
): void {
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row]!.length; column += 1) {
      if (glyph[row]![column] !== '1') continue;
      fillRect(png, x + column * scale, y + row * scale, scale, scale, color);
    }
  }
}

/** Writes one pixel, dropping anything outside the image. */
export function setPngPixel(png: PNG, x: number, y: number, color: PngGlyphColor): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const index = (png.width * y + x) * 4;
  png.data[index] = color[0];
  png.data[index + 1] = color[1];
  png.data[index + 2] = color[2];
  png.data[index + 3] = color[3];
}

function drawRectBorder(png: PNG, rect: Rect, color: PngGlyphColor, thickness: number): void {
  for (let offset = 0; offset < thickness; offset += 1) {
    drawHorizontalLine(png, rect.x, rect.x + rect.width - 1, rect.y + offset, color);
    drawHorizontalLine(
      png,
      rect.x,
      rect.x + rect.width - 1,
      rect.y + rect.height - 1 - offset,
      color,
    );
    drawVerticalLine(png, rect.x + offset, rect.y, rect.y + rect.height - 1, color);
    drawVerticalLine(
      png,
      rect.x + rect.width - 1 - offset,
      rect.y,
      rect.y + rect.height - 1,
      color,
    );
  }
}

function drawBadge(png: PNG, rect: Rect, text: string): void {
  const badgeWidth = BADGE_PADDING_X * 2 + measurePngGlyphTextWidth(text);
  const badgeHeight = BADGE_PADDING_Y * 2 + GLYPH_HEIGHT;
  const x = clamp(rect.x, 0, Math.max(0, png.width - badgeWidth));
  const preferredY = rect.y - badgeHeight - BADGE_MARGIN;
  const y =
    preferredY >= 0
      ? preferredY
      : clamp(rect.y + BADGE_MARGIN, 0, Math.max(0, png.height - badgeHeight));
  fillRect(png, x, y, badgeWidth, badgeHeight, BADGE_COLOR);
  drawPngGlyphText(png, {
    x: x + BADGE_PADDING_X,
    y: y + BADGE_PADDING_Y,
    text,
    color: TEXT_COLOR,
  });
}

function fillRect(
  png: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  color: PngGlyphColor,
): void {
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      setPngPixel(png, x + column, y + row, color);
    }
  }
}

function drawHorizontalLine(
  png: PNG,
  startX: number,
  endX: number,
  y: number,
  color: PngGlyphColor,
): void {
  for (let x = startX; x <= endX; x += 1) {
    setPngPixel(png, x, y, color);
  }
}

function drawVerticalLine(
  png: PNG,
  x: number,
  startY: number,
  endY: number,
  color: PngGlyphColor,
): void {
  for (let y = startY; y <= endY; y += 1) {
    setPngPixel(png, x, y, color);
  }
}
