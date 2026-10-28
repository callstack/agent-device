import { intersectRects, rectArea } from './rect.ts';
import type { Rect } from './snapshot.ts';

export type ImageDimensions = { width: number; height: number };

declare const normalizedRectBrand: unique symbol;

/**
 * A rect whose coordinates are normalized percentages [0..100] of the screenshot
 * image's dimensions (as produced by the screenshot-diff regions/OCR code), NOT
 * absolute pixels.
 */
export type NormalizedRect = Rect & { readonly [normalizedRectBrand]: 'normalized-rect' };

export function normalizedRect(rect: Rect): NormalizedRect {
  return rect as NormalizedRect;
}

export function intersectArea(left: Rect, right: Rect): number {
  const overlap = intersectRects(left, right);
  return overlap ? rectArea(overlap) : 0;
}
