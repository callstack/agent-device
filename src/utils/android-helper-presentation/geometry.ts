import type { Rect } from '../../kernel/snapshot.ts';

export function hasRenderableArea(rect: Rect): boolean {
  return rect.width > 0 && rect.height > 0;
}

export function isRectContainedBy(rect: Rect | undefined, container: Rect | undefined): boolean {
  if (!rect || !container) return false;
  const tolerance = 2;
  return (
    rect.x >= container.x - tolerance &&
    rect.y >= container.y - tolerance &&
    rect.x + rect.width <= container.x + container.width + tolerance &&
    rect.y + rect.height <= container.y + container.height + tolerance
  );
}

export function areSameVisualRow(left: Rect | undefined, right: Rect | undefined): boolean {
  if (!left || !right) return true;
  const leftCenterY = left.y + left.height / 2;
  const rightCenterY = right.y + right.height / 2;
  return Math.abs(leftCenterY - rightCenterY) <= Math.max(left.height, right.height, 1);
}
