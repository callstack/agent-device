import type { Rect, SnapshotViewportSize } from './snapshot.ts';

/**
 * CoreGraphics' `CGRectInfinite`, spelled in the four doubles Apple builds it from. This is what a
 * failed viewport or frame read looks like once it has crossed a JSON wire: every component of it
 * is finite, and so is every extent, and its center is `(0, 0)` (#2891).
 */
const CG_RECT_INFINITE: Rect = {
  x: -Number.MAX_VALUE / 2,
  y: -Number.MAX_VALUE / 2,
  width: Number.MAX_VALUE,
  height: Number.MAX_VALUE,
};

function isCGRectInfinite(rect: Rect): boolean {
  return (
    rect.x === CG_RECT_INFINITE.x &&
    rect.y === CG_RECT_INFINITE.y &&
    rect.width === CG_RECT_INFINITE.width &&
    rect.height === CG_RECT_INFINITE.height
  );
}

/**
 * Twin of `SnapshotGeometry.isPositiveFinite` on the runner, and the guard every viewport read passes
 * a box through before it becomes evidence (#2891). Three refusals, each reachable by a different
 * input: a non-finite component; a box whose finite components still overflow its own right or
 * bottom edge; and `CGRect.infinite`, which the two numeric checks let through and which the Swift
 * twin refuses with `!rect.isInfinite`. The sentinel is refused by value here rather than in one
 * producer's parser because the producers are many — the simulator AX bridge, the runner wire, a
 * remote provider's tree — and a viewport box that reaches the guard-free predicate makes every node
 * center on the screen land inside it.
 */
export function isPositiveFiniteRect(rect: Rect | undefined): rect is Rect {
  if (!rect) return false;
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isFinite)) return false;
  if (!Number.isFinite(x + width) || !Number.isFinite(y + height)) return false;
  if (width <= 0 || height <= 0) return false;
  return !isCGRectInfinite(rect);
}

/**
 * A failed read keeps the maximal extents of `CGRectInfinite` whatever happened to its origin, and a
 * size field carries no origin of its own: a producer that hands over the box it still holds after a
 * refused read, or a wire payload that arrives with the extents and no coordinates, would otherwise
 * publish the largest number on the wire as the screen every rect is measured in (#2891, #3182).
 */
function reportsFailedReadExtents(width: number, height: number): boolean {
  return width >= CG_RECT_INFINITE.width || height >= CG_RECT_INFINITE.height;
}

/**
 * The ONE construction path for the viewport a snapshot response publishes (#3182): a producer hands
 * over the box it read, and a box this guard refuses yields `undefined` — the absence that means
 * unknown — instead of a size with a zero in it. A producer that published a zero would be
 * answering "this screen has no width", which no producer measured; a reader that has to tell the
 * two apart can only do it when one of them is unrepresentable.
 */
export function snapshotViewportSizeFrom(box: Rect | undefined): SnapshotViewportSize | undefined {
  if (!isPositiveFiniteRect(box)) return undefined;
  if (reportsFailedReadExtents(box.width, box.height)) return undefined;
  return { width: box.width, height: box.height } as SnapshotViewportSize;
}

/**
 * Re-read of a viewport this repo already published, out of an untyped wire payload: only a
 * `{ width, height }` pair the guard accepts survives, and anything else is the absence that means
 * unknown. A reader that trusted the payload could otherwise hand a consumer the `width: 0` a broken
 * producer wrote, which is the claim {@link snapshotViewportSizeFrom} exists to make unrepresentable.
 *
 * The published shape carries no origin, so the failed read has to be recognised from its extents
 * alone: the extents check covers the payload with no coordinates as well as one that arrived with
 * the `CGRectInfinite` origin beside them.
 */
export function readSnapshotViewportSize(value: unknown): SnapshotViewportSize | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  if (x !== undefined && typeof x !== 'number') return undefined;
  if (y !== undefined && typeof y !== 'number') return undefined;
  return snapshotViewportSizeFrom({ x: x ?? 0, y: y ?? 0, width, height });
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

/** The smallest rect that contains every rect in a non-empty list. */
export function unionRects(rects: readonly Rect[]): Rect {
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

/** Point-in-rect with inclusive edges on all four bounds. */
export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/**
 * The shared `hittable` predicate every iOS snapshot producer publishes (#1933): an enabled node
 * with a positive finite frame whose center falls inside the viewport. It is the TypeScript twin of
 * the runner's Swift `SnapshotGeometry.isGeometricallyActionable`, including `CGRect.contains`'s
 * half-open right/bottom edges; `contracts/fixtures/snapshot-actionability-policy.json` pins both.
 * Callers without a viewport box withhold the bit instead of asking. The `viewport` argument is
 * trusted rather than re-checked, because a `boolean`-returning rule cannot answer "no idea": pass a
 * box {@link isPositiveFiniteRect} accepted. The Swift twin needs no such request because it takes
 * `SnapshotViewport`, whose `.missing` case is the absence of a box, and returns `Bool?`, which can.
 * The host AX bridge derives the source bit
 * from the node's own frame and the fold intersects it with the clipped frame, so a `hittable:`
 * selector cannot tell the two producers apart.
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
