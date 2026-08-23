import { isScrollableType } from '@agent-device/contracts/snapshot';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect, rectArea } from '@agent-device/kernel/rect';

type AndroidSurfaceFootprint = {
  shows: Rect[];
  hasAction: boolean;
  strongestPaint?: Rect;
};

/**
 * Finds Android replacement surfaces that remain attached behind a dominant sibling surface.
 *
 * Android API 23 omits `drawing-order`, so publication cannot use that acquisition-only fact. This
 * classifier instead compares the semantic paint footprints already present in the normalized
 * snapshot. Each subtree carries one strongest concrete paint rectangle, which keeps classification
 * linear after tree construction and avoids inventing a union across transparent gaps. The test is
 * intentionally asymmetric: a dominant surface must cover the sibling's visible footprint while
 * the sibling does not cover the dominant surface in return. Sparse debug overlays and mutually
 * full surfaces therefore stay actionable; an unambiguous replacement screen blocks stale actions.
 */
export function coveredAndroidReplacementNodeIndexes(
  nodes: readonly RawSnapshotNode[],
): ReadonlySet<number> {
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const childrenByParent = groupChildrenByParent(nodes);
  const footprintMemo = new Map<number, AndroidSurfaceFootprint>();
  const coveredRoots = findCoveredSurfaceRoots(byIndex, childrenByParent, footprintMemo);
  return expandCoveredSubtrees(coveredRoots, childrenByParent);
}

function findCoveredSurfaceRoots(
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
  childrenByParent: ReadonlyMap<number, readonly RawSnapshotNode[]>,
  footprintMemo: Map<number, AndroidSurfaceFootprint>,
): ReadonlySet<number> {
  const coveredRoots = new Set<number>();
  for (const [parentIndex, siblings] of childrenByParent) {
    const parent = byIndex.get(parentIndex);
    if (!parent || siblings.length < 2 || !isPositiveFiniteRect(parent.rect)) continue;
    const dominant = dominantSurface(siblings, parent.rect, childrenByParent, footprintMemo);
    if (!dominant) continue;
    const dominantFootprint = footprintOf(dominant, childrenByParent, footprintMemo);
    for (const sibling of siblings) {
      const siblingFootprint = footprintOf(sibling, childrenByParent, footprintMemo);
      if (sibling.index !== dominant.index && isCoveredBy(dominantFootprint, siblingFootprint)) {
        coveredRoots.add(sibling.index);
      }
    }
  }
  return coveredRoots;
}

function isCoveredBy(dominant: AndroidSurfaceFootprint, sibling: AndroidSurfaceFootprint): boolean {
  const dominantPaint = dominant.strongestPaint;
  if (!dominantPaint || coverageByRect(sibling.shows, dominantPaint) < 0.9) return false;
  return !sibling.strongestPaint || coverageByRect([dominantPaint], sibling.strongestPaint) < 0.9;
}

function groupChildrenByParent(nodes: readonly RawSnapshotNode[]): Map<number, RawSnapshotNode[]> {
  const grouped = new Map<number, RawSnapshotNode[]>();
  for (const node of nodes) {
    if (typeof node.parentIndex !== 'number') continue;
    const siblings = grouped.get(node.parentIndex) ?? [];
    siblings.push(node);
    grouped.set(node.parentIndex, siblings);
  }
  return grouped;
}

function dominantSurface(
  siblings: readonly RawSnapshotNode[],
  parentRect: Rect,
  childrenByParent: ReadonlyMap<number, readonly RawSnapshotNode[]>,
  footprintMemo: Map<number, AndroidSurfaceFootprint>,
): RawSnapshotNode | undefined {
  const minimumSurfaceArea = rectArea(parentRect) * 0.5;
  const candidates = siblings
    .filter((node) => isPositiveFiniteRect(node.rect) && rectArea(node.rect) >= minimumSurfaceArea)
    .flatMap((node) => {
      const footprint = footprintOf(node, childrenByParent, footprintMemo);
      return footprint.hasAction && footprint.strongestPaint
        ? [{ node, strongestPaint: footprint.strongestPaint, shownRects: footprint.shows.length }]
        : [];
    });
  return candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, candidate) => (!best || outranks(candidate, best) ? candidate : best),
    undefined,
  )?.node;
}

function outranks(
  candidate: { node: RawSnapshotNode; strongestPaint: Rect; shownRects: number },
  incumbent: { node: RawSnapshotNode; strongestPaint: Rect; shownRects: number },
): boolean {
  const areaDifference = rectArea(candidate.strongestPaint) - rectArea(incumbent.strongestPaint);
  if (areaDifference !== 0) return areaDifference > 0;
  if (candidate.shownRects !== incumbent.shownRects)
    return candidate.shownRects > incumbent.shownRects;
  return candidate.node.index < incumbent.node.index;
}

function footprintOf(
  node: RawSnapshotNode,
  childrenByParent: ReadonlyMap<number, readonly RawSnapshotNode[]>,
  memo: Map<number, AndroidSurfaceFootprint>,
): AndroidSurfaceFootprint {
  const cached = memo.get(node.index);
  if (cached) return cached;
  const children = childrenByParent.get(node.index) ?? [];
  const childFootprints = children.map((child) => footprintOf(child, childrenByParent, memo));
  const ownPaint = semanticPaintRect(node, children.length);
  const footprint = {
    shows: visibleRects(node, ownPaint, childFootprints),
    hasAction: node.hittable === true || childFootprints.some((child) => child.hasAction),
    strongestPaint:
      ownPaint ??
      largestRect(childFootprints.flatMap((footprint) => footprint.strongestPaint ?? [])),
  };
  memo.set(node.index, footprint);
  return footprint;
}

function semanticPaintRect(node: RawSnapshotNode, childCount: number): Rect | undefined {
  if (!isPositiveFiniteRect(node.rect)) return undefined;
  const paintsOwnBox =
    node.hittable === true ||
    isScrollableType(node.type) ||
    (childCount === 0 && hasSemanticContent(node));
  return paintsOwnBox ? node.rect : undefined;
}

function visibleRects(
  node: RawSnapshotNode,
  ownPaint: Rect | undefined,
  children: readonly AndroidSurfaceFootprint[],
): Rect[] {
  if (ownPaint) return [ownPaint];
  const childRects = children.flatMap((footprint) => footprint.shows);
  return isPositiveFiniteRect(node.rect) && hasSemanticContent(node)
    ? [...childRects, node.rect]
    : childRects;
}

function hasSemanticContent(node: RawSnapshotNode): boolean {
  return Boolean(node.label?.trim() || node.value?.trim() || node.identifier?.trim());
}

/** Fraction of the target footprint covered by one concrete semantic paint rectangle. */
function coverageByRect(targetRects: readonly Rect[], coveringRect: Rect): number {
  const targetArea = targetRects.reduce((total, rect) => total + rectArea(rect), 0);
  if (targetArea <= 0) return 0;
  const coveredArea = targetRects.reduce(
    (total, target) => total + intersectionArea(target, coveringRect),
    0,
  );
  return coveredArea / targetArea;
}

function largestRect(rects: readonly Rect[]): Rect | undefined {
  let largest: Rect | undefined;
  for (const rect of rects) {
    if (!largest || rectArea(rect) > rectArea(largest)) largest = rect;
  }
  return largest;
}

function intersectionArea(left: Rect, right: Rect): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return width * height;
}

function expandCoveredSubtrees(
  coveredRoots: ReadonlySet<number>,
  childrenByParent: ReadonlyMap<number, readonly RawSnapshotNode[]>,
): ReadonlySet<number> {
  const covered = new Set<number>();
  const stack = [...coveredRoots];
  while (stack.length > 0) {
    const index = stack.pop()!;
    if (covered.has(index)) continue;
    covered.add(index);
    for (const child of childrenByParent.get(index) ?? []) stack.push(child.index);
  }
  return covered;
}
