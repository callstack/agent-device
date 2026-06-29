import type { Rect } from '../kernel/snapshot.ts';

export function hasPositiveRect(rect: Rect | undefined): rect is Rect {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

export function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

export function rectContains(container: Rect, nested: Rect): boolean {
  return (
    nested.x >= container.x &&
    nested.y >= container.y &&
    nested.x + nested.width <= container.x + container.width &&
    nested.y + nested.height <= container.y + container.height
  );
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
