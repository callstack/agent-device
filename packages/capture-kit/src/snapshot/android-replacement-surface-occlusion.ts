import { isScrollableType } from '@agent-device/contracts/snapshot';
import type { AndroidSiblingOrderEvidence } from '@agent-device/contracts/capture';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { unionCoverage } from './rect-coverage.ts';

type SurfaceFootprint = {
  showRect?: Rect;
  showChildren: readonly SurfaceFootprint[];
  paintRect?: Rect;
  paintChildren: readonly SurfaceFootprint[];
  hasAction: boolean;
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
  if (!candidateOrder || !candidateFootprint?.hasAction) return false;
  if (candidateOrder.group !== targetOrder.group || candidateOrder.order <= targetOrder.order) {
    return false;
  }
  const coveringRects = footprintRects(candidateFootprint, 'paint', scan.budget);
  const coveredRects = footprintRects(targetFootprint, 'show', scan.budget);
  if (scan.budget.exhausted) return false;
  const coverage = unionCoverage(coveringRects, coveredRects, (units) =>
    consumeUnits(scan.budget, units),
  );
  return coverage !== undefined && coverage >= MINIMUM_OCCLUSION_COVERAGE;
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
  return {
    ...(showRect ? { showRect } : {}),
    showChildren: ownPaint ? [] : children,
    ...(ownPaint ? { paintRect: ownPaint } : {}),
    paintChildren: ownPaint ? [] : children,
    hasAction: node.hittable === true || children.some(hasAction),
  };
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

function footprintRects(
  root: SurfaceFootprint,
  kind: 'paint' | 'show',
  budget: WorkBudget,
): Rect[] {
  const rects: Rect[] = [];
  const pending = [root];
  while (pending.length > 0) {
    if (!consume(budget)) return rects;
    const footprint = pending.pop()!;
    const rect = kind === 'paint' ? footprint.paintRect : footprint.showRect;
    if (rect) rects.push(rect);
    pending.push(...(kind === 'paint' ? footprint.paintChildren : footprint.showChildren));
  }
  return rects;
}

function consume(budget: WorkBudget): boolean {
  return consumeUnits(budget, 1);
}

function consumeUnits(budget: WorkBudget, units: number): boolean {
  if (units > budget.remaining) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= units;
  return true;
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
