import type { Point, Rect } from '../kernel/snapshot.ts';

export type ImageDimensions = { width: number; height: number };

declare const normalizedRectBrand: unique symbol;
declare const normalizedPointBrand: unique symbol;

/**
 * A rect whose coordinates are normalized percentages [0..100] of the screenshot
 * image's dimensions (as produced by the screenshot-diff regions/OCR code), NOT
 * absolute pixels.
 */
export type NormalizedRect = Rect & { readonly [normalizedRectBrand]: 'normalized-rect' };

/** A point in normalized [0..100] screenshot-image space. */
export type NormalizedPoint = Point & { readonly [normalizedPointBrand]: 'normalized-point' };

export function normalizedRect(rect: Rect): NormalizedRect {
  return rect as NormalizedRect;
}

export function unionRects(rects: Rect[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function expandRect(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

export function intersectArea(left: Rect, right: Rect): number {
  const minX = Math.max(left.x, right.x);
  const minY = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);
  if (maxX <= minX || maxY <= minY) return 0;
  return (maxX - minX) * (maxY - minY);
}

export function rectCenter(rect: NormalizedRect): NormalizedPoint;
export function rectCenter(rect: Rect): Point;
export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function squaredDistance(
  left: { x: number; y: number },
  right: { x: number; y: number },
): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
