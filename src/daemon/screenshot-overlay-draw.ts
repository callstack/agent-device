import type { Rect, ScreenshotOverlayRef } from '@agent-device/kernel/snapshot';
import type { PNG } from '@agent-device/capture-kit/png';
import { clamp } from '../snapshot/screenshot-overlay/rects.ts';

/**
 * Rasterizing one overlay ref onto a decoded PNG: border, badge, and the bitmap glyphs the badge
 * needs. Which node earns a ref, and where its rect lands, is `screenshot-overlay.ts`'s question —
 * this module only paints what it is handed.
 */
const BORDER_COLOR = [255, 59, 48, 255] as const;
const BADGE_COLOR = [255, 214, 10, 255] as const;
const TEXT_COLOR = [0, 0, 0, 255] as const;
const FONT_WIDTH = 5;
const FONT_HEIGHT = 7;
const FONT_SPACING = 1;
const BADGE_PADDING_X = 3;
const BADGE_PADDING_Y = 2;
const BADGE_MARGIN = 2;
const BORDER_THICKNESS = 2;
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
} as const;
// Badges currently render only `eN` refs, so the bitmap font intentionally covers `e` and digits.

export function drawOverlayRef(png: PNG, overlayRef: ScreenshotOverlayRef): void {
  drawRectBorder(png, overlayRef.overlayRect, BORDER_COLOR, BORDER_THICKNESS);
  drawBadge(png, overlayRef.overlayRect, overlayRef.ref);
}

function drawRectBorder(
  png: PNG,
  rect: Rect,
  color: readonly [number, number, number, number],
  thickness: number,
): void {
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
  const badgeWidth =
    BADGE_PADDING_X * 2 + text.length * FONT_WIDTH + Math.max(0, text.length - 1) * FONT_SPACING;
  const badgeHeight = BADGE_PADDING_Y * 2 + FONT_HEIGHT;
  const x = clamp(rect.x, 0, Math.max(0, png.width - badgeWidth));
  const preferredY = rect.y - badgeHeight - BADGE_MARGIN;
  const y =
    preferredY >= 0
      ? preferredY
      : clamp(rect.y + BADGE_MARGIN, 0, Math.max(0, png.height - badgeHeight));
  fillRect(png, x, y, badgeWidth, badgeHeight, BADGE_COLOR);
  drawText(png, x + BADGE_PADDING_X, y + BADGE_PADDING_Y, text, TEXT_COLOR);
}

function drawText(
  png: PNG,
  x: number,
  y: number,
  text: string,
  color: readonly [number, number, number, number],
): void {
  let cursorX = x;
  for (const character of text.toLowerCase()) {
    const glyph = FONT[character];
    if (glyph) {
      for (let row = 0; row < glyph.length; row += 1) {
        for (let column = 0; column < glyph[row]!.length; column += 1) {
          if (glyph[row]![column] !== '1') continue;
          setPixel(png, cursorX + column, y + row, color);
        }
      }
    }
    cursorX += FONT_WIDTH + FONT_SPACING;
  }
}

function fillRect(
  png: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly [number, number, number, number],
): void {
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      setPixel(png, x + column, y + row, color);
    }
  }
}

function drawHorizontalLine(
  png: PNG,
  startX: number,
  endX: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  for (let x = startX; x <= endX; x += 1) {
    setPixel(png, x, y, color);
  }
}

function drawVerticalLine(
  png: PNG,
  x: number,
  startY: number,
  endY: number,
  color: readonly [number, number, number, number],
): void {
  for (let y = startY; y <= endY; y += 1) {
    setPixel(png, x, y, color);
  }
}

function setPixel(
  png: PNG,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const index = (png.width * y + x) * 4;
  png.data[index] = color[0];
  png.data[index + 1] = color[1];
  png.data[index + 2] = color[2];
  png.data[index + 3] = color[3];
}
