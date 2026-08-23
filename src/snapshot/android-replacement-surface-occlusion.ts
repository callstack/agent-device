import { isScrollableType } from '@agent-device/contracts/snapshot';
import type { AndroidSiblingOrderEvidence } from '@agent-device/contracts/capture';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect, rectArea } from '@agent-device/kernel/rect';

type SurfaceFootprint = {
  showRect?: Rect;
  showChildren: readonly SurfaceFootprint[];
  hasAction: boolean;
  strongestPaint?: Rect;
};

type WorkBudget = { remaining: number; exhausted: boolean };
type OcclusionScan = {
  footprints: ReadonlyMap<number, SurfaceFootprint>;
  siblingOrders: ReadonlyMap<number, AndroidSiblingOrderEvidence>;
  budget: WorkBudget;
};

const MINIMUM_OCCLUSION_COVERAGE = 0.9;
const WORK_UNITS_PER_NODE = 128;

/**
 * Finds Android sibling surfaces covered by a higher, exactly ordered sibling.
 *
 * The order map is private acquisition evidence: Android exposes it from API 24 onward. Missing or
 * exhausted evidence fails conservative, so geometry never guesses which sibling is in front.
 */
export function coveredAndroidReplacementNodeIndexes(
  nodes: readonly RawSnapshotNode[],
  siblingOrderByNodeIndex: ReadonlyMap<number, AndroidSiblingOrderEvidence> = new Map(),
): ReadonlySet<number> {
  if (siblingOrderByNodeIndex.size === 0) return new Set();
  const childrenByParent = collectChildrenByParent(nodes);
  const footprints = buildSurfaceFootprints(nodes, childrenByParent);
  const budget = {
    remaining: Math.max(1024, nodes.length * WORK_UNITS_PER_NODE),
    exhausted: false,
  };
  const coveredRoots = findCoveredRoots(childrenByParent, {
    footprints,
    siblingOrders: siblingOrderByNodeIndex,
    budget,
  });
  return budget.exhausted ? new Set() : expandSubtrees(coveredRoots, childrenByParent);
}

function findCoveredRoots(
  childrenByParent: ReadonlyMap<number, readonly RawSnapshotNode[]>,
  scan: OcclusionScan,
): ReadonlySet<number> {
  const covered = new Set<number>();
  for (const siblings of childrenByParent.values()) {
    for (const target of siblings) {
      if (isCoveredBySibling(target, siblings, scan)) covered.add(target.index);
      if (scan.budget.exhausted) return covered;
    }
  }
  return covered;
}

function isCoveredBySibling(
  target: RawSnapshotNode,
  siblings: readonly RawSnapshotNode[],
  scan: OcclusionScan,
): boolean {
  const targetOrder = scan.siblingOrders.get(target.index);
  const targetFootprint = scan.footprints.get(target.index);
  if (!targetOrder || !targetFootprint) return false;
  for (const candidate of siblings) {
    if (!consume(scan.budget)) return false;
    if (canCover(targetOrder, targetFootprint, candidate, scan)) return true;
  }
  return false;
}

function canCover(
  targetOrder: AndroidSiblingOrderEvidence,
  targetFootprint: SurfaceFootprint,
  candidate: RawSnapshotNode,
  scan: OcclusionScan,
): boolean {
  const candidateOrder = scan.siblingOrders.get(candidate.index);
  const candidateFootprint = scan.footprints.get(candidate.index);
  const candidatePaint = candidateFootprint?.strongestPaint;
  if (!candidateOrder || !candidateFootprint?.hasAction || !candidatePaint) return false;
  if (candidateOrder.group !== targetOrder.group || candidateOrder.order <= targetOrder.order) {
    return false;
  }
  return (
    footprintCoverageByRect(targetFootprint, candidatePaint, scan.budget) >=
    MINIMUM_OCCLUSION_COVERAGE
  );
}

function collectChildrenByParent(
  nodes: readonly RawSnapshotNode[],
): Map<number, RawSnapshotNode[]> {
  const grouped = new Map<number, RawSnapshotNode[]>();
  for (const node of nodes) {
    if (typeof node.parentIndex !== 'number') continue;
    const children = grouped.get(node.parentIndex) ?? [];
    children.push(node);
    grouped.set(node.parentIndex, children);
  }
  return grouped;
}

/** Android presentation emits document order, so every child's footprint exists in this reverse fold. */
function buildSurfaceFootprints(
  nodes: readonly RawSnapshotNode[],
  childrenByParent: ReadonlyMap<number, readonly RawSnapshotNode[]>,
): ReadonlyMap<number, SurfaceFootprint> {
  const footprints = new Map<number, SurfaceFootprint>();
  for (let position = nodes.length - 1; position >= 0; position -= 1) {
    const node = nodes[position]!;
    const children = childrenByParent.get(node.index) ?? [];
    const childFootprints = children.flatMap((child) => footprints.get(child.index) ?? []);
    footprints.set(node.index, surfaceFootprint(node, children.length, childFootprints));
  }
  return footprints;
}

function surfaceFootprint(
  node: RawSnapshotNode,
  childCount: number,
  children: readonly SurfaceFootprint[],
): SurfaceFootprint {
  const ownPaint = semanticPaintRect(node, childCount);
  const showRect = ownPaint ?? semanticShowRect(node);
  const strongestPaint = largestPaintRect(ownPaint, children);
  return {
    ...(showRect ? { showRect } : {}),
    showChildren: ownPaint ? [] : children,
    hasAction: node.hittable === true || children.some(hasAction),
    ...(strongestPaint ? { strongestPaint } : {}),
  };
}

function largestPaintRect(
  ownPaint: Rect | undefined,
  children: readonly SurfaceFootprint[],
): Rect | undefined {
  return children.reduce<Rect | undefined>((largest, child) => {
    const candidate = child.strongestPaint;
    return candidate && (!largest || rectArea(candidate) > rectArea(largest)) ? candidate : largest;
  }, ownPaint);
}

function hasAction(footprint: SurfaceFootprint): boolean {
  return footprint.hasAction;
}

function semanticPaintRect(node: RawSnapshotNode, childCount: number): Rect | undefined {
  if (!isPositiveFiniteRect(node.rect)) return undefined;
  return node.hittable === true ||
    isScrollableType(node.type) ||
    (childCount === 0 && hasSemanticContent(node))
    ? node.rect
    : undefined;
}

function semanticShowRect(node: RawSnapshotNode): Rect | undefined {
  return isPositiveFiniteRect(node.rect) && hasSemanticContent(node) ? node.rect : undefined;
}

function hasSemanticContent(node: RawSnapshotNode): boolean {
  return Boolean(node.label?.trim() || node.value?.trim() || node.identifier?.trim());
}

function footprintCoverageByRect(
  target: SurfaceFootprint,
  coveringRect: Rect,
  budget: WorkBudget,
): number {
  let targetArea = 0;
  let coveredArea = 0;
  const pending = [target];
  while (pending.length > 0) {
    if (!consume(budget)) return 0;
    const footprint = pending.pop()!;
    if (footprint.showRect) {
      targetArea += rectArea(footprint.showRect);
      coveredArea += intersectionArea(footprint.showRect, coveringRect);
    }
    pending.push(...footprint.showChildren);
  }
  return targetArea <= 0 ? 0 : coveredArea / targetArea;
}

function consume(budget: WorkBudget): boolean {
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= 1;
  return true;
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

function expandSubtrees(
  roots: ReadonlySet<number>,
  childrenByParent: ReadonlyMap<number, readonly RawSnapshotNode[]>,
): ReadonlySet<number> {
  const covered = new Set<number>();
  const pending = [...roots];
  while (pending.length > 0) {
    const index = pending.pop()!;
    if (covered.has(index)) continue;
    covered.add(index);
    for (const child of childrenByParent.get(index) ?? []) pending.push(child.index);
  }
  return covered;
}
