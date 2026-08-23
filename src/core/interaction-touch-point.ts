import type { Point, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { containsPoint } from '@agent-device/kernel/rect';
import {
  areRectsApproximatelyEqual,
  normalizeRect,
  resolveRectCenter,
} from '../utils/rect-center.ts';
import { isSemanticTouchTarget } from './touch-semantics.ts';

export type InteractionTouchPointResolution =
  | { kind: 'resolved'; point: Point; strategy: 'center' | 'parent-owned' }
  | { kind: 'blocked'; competitorRefs: string[] }
  | { kind: 'invalid' };

const MIN_COMPETITOR_CLEARANCE = 12;
const MAX_PARENT_EDGE_CLEARANCE = 12;

type InteractiveDescendantRect = { ref: string; index: number; rect: Rect };
type RankedPoint = { point: Point; distanceSquared: number; clearance: number };
type PointClearance = { parentEdge: number; competitor: number };

export function resolveInteractionTouchPoint(
  nodes: readonly SnapshotNode[],
  node: SnapshotNode,
  options: { bounds?: readonly Rect[] } = {},
): InteractionTouchPointResolution {
  const targetRect = normalizeRect(node.rect);
  const center = resolveRectCenter(targetRect ?? undefined);
  if (!targetRect || !center) return { kind: 'invalid' };

  const competitors = collectInteractiveDescendantRects(nodes, node, targetRect);
  if (competitors.length === 0) {
    return { kind: 'resolved', point: center, strategy: 'center' };
  }

  const searchRect = (options.bounds ?? []).reduce<Rect | null>(
    (current, bound) => (current ? intersectRects(current, bound) : null),
    targetRect,
  );
  const point = searchRect
    ? findNearestParentOwnedPoint(targetRect, searchRect, center, competitors)
    : null;
  if (!point) {
    return {
      kind: 'blocked',
      competitorRefs: competitors.map((competitor) => competitor.ref),
    };
  }
  return { kind: 'resolved', point, strategy: 'parent-owned' };
}

function collectInteractiveDescendantRects(
  nodes: readonly SnapshotNode[],
  node: SnapshotNode,
  targetRect: Rect,
): InteractiveDescendantRect[] {
  const byIndex = new Map(nodes.map((candidate) => [candidate.index, candidate]));
  return (
    nodes
      .filter((candidate) => candidate.index !== node.index)
      .filter((candidate) => isDescendantOf(candidate, node, byIndex))
      // Deliberately use semantic roles, not `hittable`: iOS commonly marks
      // static text hittable, and treating that as a competing control would
      // erase the parent-owned text region we need to preserve.
      .filter(isSemanticTouchTarget)
      .flatMap((candidate) => {
        const rect = normalizeRect(candidate.rect);
        if (!rect || areRectsApproximatelyEqual(rect, targetRect)) return [];
        const clipped = intersectRects(rect, targetRect);
        return clipped && clipped.width > 0 && clipped.height > 0
          ? [{ ref: candidate.ref, index: candidate.index, rect: clipped }]
          : [];
      })
      .sort((left, right) => left.index - right.index)
  );
}

function isDescendantOf(
  candidate: SnapshotNode,
  ancestor: SnapshotNode,
  byIndex: ReadonlyMap<number, SnapshotNode>,
): boolean {
  const visited = new Set<number>();
  let current = candidate;
  while (typeof current.parentIndex === 'number' && !visited.has(current.index)) {
    visited.add(current.index);
    if (current.parentIndex === ancestor.index) return true;
    const parent = byIndex.get(current.parentIndex);
    if (!parent) return false;
    current = parent;
  }
  return false;
}

function intersectRects(left: Rect, right: Rect): Rect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);
  if (maxX <= x || maxY <= y) return null;
  return { x, y, width: maxX - x, height: maxY - y };
}

/**
 * Finds the smallest deterministic move away from the historical center that
 * leaves enough clearance from the parent edge and every independently
 * interactive descendant. Candidate axes come from every geometry boundary,
 * so any usable free region contributes at least one point without a pixel
 * scan or device round trip.
 */
function findNearestParentOwnedPoint(
  targetRect: Rect,
  searchRect: Rect,
  center: Point,
  competitors: readonly InteractiveDescendantRect[],
): Point | null {
  const parentEdgeClearance = resolveParentEdgeClearance(targetRect);
  const xCandidates = candidateAxisCoordinates(
    searchRect.x,
    searchRect.width,
    center.x,
    competitors.flatMap(({ rect }) => [rect.x, rect.x + rect.width]),
    parentEdgeClearance,
  );
  const yCandidates = candidateAxisCoordinates(
    searchRect.y,
    searchRect.height,
    center.y,
    competitors.flatMap(({ rect }) => [rect.y, rect.y + rect.height]),
    parentEdgeClearance,
  );

  const rankedPoints = xCandidates.flatMap((x) =>
    yCandidates.flatMap((y) => {
      const point = { x: Math.round(x), y: Math.round(y) };
      if (!containsPoint(searchRect, point.x, point.y)) return [];
      const ranked = rankParentOwnedPoint(
        point,
        targetRect,
        center,
        competitors,
        parentEdgeClearance,
      );
      return ranked ? [ranked] : [];
    }),
  );
  return rankedPoints.sort(compareRankedPoints)[0]?.point ?? null;
}

function rankParentOwnedPoint(
  point: Point,
  targetRect: Rect,
  center: Point,
  competitors: readonly InteractiveDescendantRect[],
  parentEdgeClearance: number,
): RankedPoint | null {
  const clearance = pointClearance(point, targetRect, competitors);
  if (
    clearance.parentEdge < parentEdgeClearance ||
    clearance.competitor < MIN_COMPETITOR_CLEARANCE
  ) {
    return null;
  }
  const distanceSquared = (point.x - center.x) ** 2 + (point.y - center.y) ** 2;
  return {
    point,
    distanceSquared,
    clearance: Math.min(clearance.parentEdge, clearance.competitor),
  };
}

function compareRankedPoints(left: RankedPoint, right: RankedPoint): number {
  return (
    left.distanceSquared - right.distanceSquared ||
    right.clearance - left.clearance ||
    left.point.y - right.point.y ||
    left.point.x - right.point.x
  );
}

function candidateAxisCoordinates(
  origin: number,
  size: number,
  center: number,
  obstacleEdges: readonly number[],
  parentEdgeClearance: number,
): number[] {
  const min = origin + parentEdgeClearance;
  const max = origin + size - parentEdgeClearance;
  if (min > max) return [];
  const boundaries = [...new Set([origin, origin + size, ...obstacleEdges])].sort((a, b) => a - b);
  const candidates = new Set<number>([center, min, max]);
  for (const edge of obstacleEdges) {
    candidates.add(edge - MIN_COMPETITOR_CLEARANCE);
    candidates.add(edge + MIN_COMPETITOR_CLEARANCE);
  }
  for (let index = 1; index < boundaries.length; index += 1) {
    candidates.add((boundaries[index - 1]! + boundaries[index]!) / 2);
  }
  return [...candidates].filter((value) => value >= min && value <= max).sort((a, b) => a - b);
}

function pointClearance(
  point: Point,
  targetRect: Rect,
  competitors: readonly InteractiveDescendantRect[],
): PointClearance {
  const parentEdge = Math.min(
    point.x - targetRect.x,
    targetRect.x + targetRect.width - point.x,
    point.y - targetRect.y,
    targetRect.y + targetRect.height - point.y,
  );
  let competitor = Number.POSITIVE_INFINITY;
  for (const { rect } of competitors) {
    const dx = point.x < rect.x ? rect.x - point.x : Math.max(0, point.x - (rect.x + rect.width));
    const dy = point.y < rect.y ? rect.y - point.y : Math.max(0, point.y - (rect.y + rect.height));
    competitor = Math.min(competitor, Math.max(dx, dy));
  }
  return { parentEdge, competitor };
}

function resolveParentEdgeClearance(targetRect: Rect): number {
  const shortAxis = Math.min(targetRect.width, targetRect.height);
  return Math.max(0, Math.min(MAX_PARENT_EDGE_CLEARANCE, Math.floor(shortAxis / 2) - 1));
}
