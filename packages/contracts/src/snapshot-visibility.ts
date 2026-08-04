import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  containsPoint,
  isRectVisibleInViewport,
  resolveViewportRect,
} from './snapshot-geometry.ts';
import { isScrollableNodeLike } from './snapshot-scroll.ts';
import { buildSnapshotNodeMap } from './snapshot-tree.ts';

type SnapshotVisibilityNode = Pick<
  SnapshotNode,
  'rect' | 'index' | 'parentIndex' | 'type' | 'role' | 'subrole'
>;

export function isNodeVisibleInEffectiveViewport(
  node: SnapshotVisibilityNode,
  nodes: SnapshotNode[],
  byIndex: ReadonlyMap<number, SnapshotNode> = buildSnapshotNodeMap(nodes),
): boolean {
  if (!node.rect) {
    return true;
  }
  const viewport = resolveEffectiveViewportRect(node, nodes, byIndex);
  if (!viewport) {
    return true;
  }
  return isRectVisibleInViewport(node.rect, viewport);
}

// Effective-viewport visibility measures a node against its nearest scrollable
// ancestor, so items inside an off-screen container (e.g. a closed drawer's own
// ScrollView at negative x) still read as "visible" within that container.
// On-screen visibility additionally requires the node's CENTER — the point an
// interaction would tap — to sit inside the root Application/Window viewport.
// Edge overlap is not enough: a mostly-off-screen drawer container can graze the
// viewport by a fraction of a pixel while its center is far off-screen.
export function isNodeVisibleOnScreen(
  node: SnapshotVisibilityNode,
  nodes: SnapshotNode[],
  byIndex: ReadonlyMap<number, SnapshotNode> = buildSnapshotNodeMap(nodes),
): boolean {
  if (!node.rect) {
    return true;
  }
  if (!isNodeVisibleInEffectiveViewport(node, nodes, byIndex)) {
    return false;
  }
  const rootViewport = resolveViewportRect(nodes, node.rect);
  return isTapPointInsideViewport(node.rect, rootViewport);
}

// The tap-point rule shared with the iOS runner (ADR 0011 Layer 2): the tap
// point is the rect's exact CENTER; it is inside the viewport iff it lies
// within the frame, edges inclusive. A missing, empty, or invalid viewport
// fails open (allowed). The Swift twin and this function are checked against
// contracts/fixtures/tap-point-policy.json; change the rule only via that table.
export function isTapPointInsideViewport(rect: Rect, viewport: Rect | null): boolean {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    return true;
  }
  return containsPoint(viewport, rect.x + rect.width / 2, rect.y + rect.height / 2);
}

export function resolveEffectiveViewportRect(
  node: SnapshotVisibilityNode,
  nodes: SnapshotNode[],
  byIndex: ReadonlyMap<number, SnapshotNode> = buildSnapshotNodeMap(nodes),
): Rect | null {
  const clippingAncestorRect = findNearestScrollableAncestor(node, byIndex, (ancestor) =>
    Boolean(ancestor.rect),
  )?.rect;
  if (clippingAncestorRect) {
    return clippingAncestorRect;
  }
  return resolveViewportRect(nodes, node.rect ?? { x: 0, y: 0, width: 0, height: 0 });
}

/** Finds the nearest scrollable ancestor that satisfies the optional predicate. */
export function findNearestScrollableAncestor(
  node: SnapshotVisibilityNode,
  byIndex: ReadonlyMap<number, SnapshotNode>,
  predicate: (node: SnapshotNode) => boolean = () => true,
): SnapshotNode | null {
  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  const visited = new Set<number>();
  while (current && !visited.has(current.index)) {
    visited.add(current.index);
    if (predicate(current) && isScrollableNodeLike(current)) {
      return current;
    }
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
  return null;
}
