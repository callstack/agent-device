import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';

export type MaestroPositionRelation = 'below' | 'above' | 'leftOf' | 'rightOf';

/**
 * Reproduces Maestro v2.5.1 `Filters.relativeTo` and its four predicates:
 * `below` is `it.bounds.y > other.bounds.y`, `above` is `<`, `leftOf` is
 * `it.bounds.x < other.bounds.x`, and `rightOf` is `>`. It enumerates
 * candidate/anchor pairs and sorts the intermediate pairs by center-to-center
 * distance. Maestro's `Bounds.center()` uses Kotlin integer division and
 * `Point.distance` stores the square-root result as Float, so the runtime must
 * truncate half-dimensions and round the distance to Float32. The later
 * selector intersection consumes this as a set, so callers that need final
 * selector order must retain their base order rather than treating the nearest
 * pair as the winner.
 */
export function selectMaestroPositionMatches(
  nodes: readonly SnapshotNode[],
  relation: MaestroPositionRelation,
  anchors: readonly SnapshotNode[],
): SnapshotNode[] {
  const pairs: Array<{ node: SnapshotNode; distance: number; order: number }> = [];
  let order = 0;
  for (const node of nodes) {
    for (const other of anchors) {
      const distance = positionDistance(node.rect, other.rect);
      if (distance === undefined || !qualifies(relation, node.rect!, other.rect!)) continue;
      pairs.push({ node, distance, order: order++ });
    }
  }
  pairs.sort((left, right) => left.distance - right.distance || left.order - right.order);
  return pairs.map(({ node }) => node);
}

function qualifies(relation: MaestroPositionRelation, candidate: Rect, anchor: Rect): boolean {
  switch (relation) {
    case 'below':
      return candidate.y > anchor.y;
    case 'above':
      return candidate.y < anchor.y;
    case 'leftOf':
      return candidate.x < anchor.x;
    case 'rightOf':
      return candidate.x > anchor.x;
  }
}

function positionDistance(
  candidate: Rect | undefined,
  anchor: Rect | undefined,
): number | undefined {
  // Maestro's UiElement parser only requires finite bounds coordinates. In
  // particular, zero-sized (and even reversed) bounds remain usable for
  // relativeTo comparisons; positive-area validation belongs to viewport and
  // point-action geometry, not selector relations.
  if (!isFiniteRect(candidate) || !isFiniteRect(anchor)) return undefined;
  return Math.fround(
    Math.hypot(
      centerCoordinate(candidate.x, candidate.width) - centerCoordinate(anchor.x, anchor.width),
      centerCoordinate(candidate.y, candidate.height) - centerCoordinate(anchor.y, anchor.height),
    ),
  );
}

function isFiniteRect(rect: Rect | undefined): rect is Rect {
  return Boolean(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite));
}

function centerCoordinate(origin: number, size: number): number {
  return origin + Math.trunc(size / 2);
}
