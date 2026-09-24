import type { Rect } from './snapshot.ts';

/** Twin of `SnapshotGeometry.isPositiveFinite` on the runner (#2891). */
export function isPositiveFiniteRect(rect: Rect | undefined): rect is Rect {
  return Boolean(
    rect &&
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0,
  );
}

export function rectContains(container: Rect, nested: Rect): boolean {
  return (
    nested.x >= container.x &&
    nested.y >= container.y &&
    nested.x + nested.width <= container.x + container.width &&
    nested.y + nested.height <= container.y + container.height
  );
}

export function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

/** Point-in-rect with inclusive edges on all four bounds. */
export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/**
 * The shared `hittable` predicate every iOS snapshot producer publishes (#1933): an enabled node
 * with a positive finite frame whose center falls inside the viewport. It is the TypeScript twin of
 * the runner's Swift `SnapshotGeometry.isGeometricallyActionable`, including `CGRect.contains`'s
 * half-open right/bottom edges; `contracts/fixtures/snapshot-actionability-policy.json` pins both.
 * Callers without a viewport box withhold the bit instead of asking. The host AX bridge derives the
 * source bit from the node's own frame and the fold intersects it with the clipped frame, so a
 * `hittable:` selector cannot tell the two producers apart.
 */
export function isGeometricallyActionable(
  enabled: boolean,
  rect: Rect | undefined,
  viewport: Rect,
): boolean {
  if (!enabled || !isPositiveFiniteRect(rect)) return false;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  return (
    centerX >= viewport.x &&
    centerX < viewport.x + viewport.width &&
    centerY >= viewport.y &&
    centerY < viewport.y + viewport.height
  );
}

export function pickLargestRect(rects: readonly Rect[]): Rect | null {
  let best: Rect | null = null;
  let bestArea = -1;
  for (const rect of rects) {
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = rect;
      bestArea = area;
    }
  }
  return best;
}

/** Inclusive-edge overlap on both axes: touching a viewport edge still counts as visible. */
export function isRectVisibleInViewport(targetRect: Rect, viewportRect: Rect): boolean {
  return (
    rangesOverlapInclusive(
      targetRect.x,
      targetRect.x + targetRect.width,
      viewportRect.x,
      viewportRect.x + viewportRect.width,
    ) &&
    rangesOverlapInclusive(
      targetRect.y,
      targetRect.y + targetRect.height,
      viewportRect.y,
      viewportRect.y + viewportRect.height,
    )
  );
}

function rangesOverlapInclusive(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return Math.max(leftStart, rightStart) <= Math.min(leftEnd, rightEnd);
}
