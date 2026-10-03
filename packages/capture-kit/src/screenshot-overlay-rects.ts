import type { Rect } from '@agent-device/kernel/snapshot';
import { rectContains } from '@agent-device/kernel/rect';

export { rectContains };

export function hasPositiveRect(rect: Rect | undefined): rect is Rect {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

export function unionRects(rects: Rect[]): Rect {
  const firstRect = rects[0];
  if (firstRect === undefined) {
    throw new Error('unionRects requires at least one rect');
  }
  let minX = firstRect.x;
  let minY = firstRect.y;
  let maxRight = firstRect.x + firstRect.width;
  let maxBottom = firstRect.y + firstRect.height;
  for (const rect of rects.slice(1)) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxRight = Math.max(maxRight, rect.x + rect.width);
    maxBottom = Math.max(maxBottom, rect.y + rect.height);
  }
  return {
    x: minX,
    y: minY,
    width: maxRight - minX,
    height: maxBottom - minY,
  };
}
