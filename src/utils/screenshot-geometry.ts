import type { Rect } from '@agent-device/kernel/snapshot';

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
  const minX = Math.max(left.x, right.x);
  const minY = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);
  if (maxX <= minX || maxY <= minY) return 0;
  return (maxX - minX) * (maxY - minY);
}
