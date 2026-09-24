import type { Rect } from './snapshot.ts';

/**
 * The rect precondition shared by every iOS snapshot producer's `hittable` claim, and the twin of
 * `SnapshotGeometry.isPositiveFinite` on the runner.
 *
 * It is a rule about numbers, not about values one platform invents. Apple's "resolved none" box,
 * `CGRect.infinite`, is built out of finite `Double`s, so no arithmetic here can recognise it; the
 * Swift side refuses it by identity because that side can name it. A frame with components that are
 * genuinely not finite is refused further upstream, by `frameFromGuest` in
 * `packages/platform-apple/src/snapshot-source/tree.ts`, before any predicate is asked (#2891).
 */
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
 * half-open right/bottom edges — a center landing exactly on the viewport's right or bottom edge is
 * not hittable on either producer — and including the node-rect precondition, which Swift used to
 * spell null/empty and so called a negative-width box, or one whose components are not finite,
 * actionable there and not here (#2891). `contracts/fixtures/snapshot-actionability-policy.json`
 * pins both sides.
 *
 * `viewport` has no unknown case to handle: every caller hands over a box its own producer declared
 * positive and finite — `viewportFromRoot` in `packages/platform-apple/src/snapshot-source/tree.ts`
 * before that path publishes the bit at all, and `resolveViewportEvidence` in
 * `packages/capture-kit/src/ios-snapshot-engine/invariants.ts`, which throws
 * `missing-viewport`/`invalid-viewport`, before the engine folds a regular presentation. Those
 * refusals are this predicate's unknown-viewport case, and they fail in the same direction as the
 * runner's, which carries the state as `SnapshotViewport.missing` and publishes no actionability
 * (#2891).
 *
 * The host AX bridge derives the source bit from the node's own frame and the fold intersects it
 * with the clipped frame, so a `hittable:` selector cannot tell the two producers apart. Kept here
 * so both packages read one definition rather than each re-encoding the rule.
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
