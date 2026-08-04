import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import {
  buildSnapshotNodeMap,
  findSnapshotAncestor,
  isUsefulVisibilityAnchor,
} from '@agent-device/contracts/snapshot';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';

export function isMaestroNodeVisible(
  node: SnapshotNode,
  nodes: SnapshotNode[],
  platform: 'android' | 'ios',
): boolean {
  if (platform === 'android' && node.visibleToUser === false) return false;
  if (isPositiveFiniteRect(node.rect)) {
    return isVisibleInEffectiveViewport(node, nodes);
  }
  if (node.rect) return false;
  if (platform !== 'android' && node.hittable === true) return true;
  const anchor = findSnapshotAncestor(nodes, node, buildSnapshotNodeMap(nodes), (parent) =>
    isUsefulVisibilityAnchor(parent, platform) ? parent : null,
  );
  if (!anchor) return false;
  if (!isPositiveFiniteRect(anchor.rect)) {
    return platform !== 'android' && anchor.hittable === true;
  }
  return isVisibleInEffectiveViewport(anchor, nodes);
}

export function isDescendantOfSnapshotNode(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  ancestor: SnapshotNode,
  nodeByIndex: ReadonlyMap<number, SnapshotNode>,
): boolean {
  return Boolean(
    findSnapshotAncestor(nodes, node, nodeByIndex, (candidate) =>
      candidate.index === ancestor.index ? candidate : null,
    ),
  );
}

function isVisibleInEffectiveViewport(node: SnapshotNode, nodes: SnapshotNode[]): boolean {
  if (!node.rect) return true;
  const byIndex = buildSnapshotNodeMap(nodes);
  const viewport =
    findScrollableAncestorRect(node, byIndex) ?? resolveRootViewport(nodes, node.rect);
  return viewport ? rectsOverlap(node.rect, viewport) : true;
}

// Structurally the same parent walk as `@agent-device/contracts/snapshot`'s
// `findNearestScrollableAncestor` and `runtime-port-geometry.ts`'s
// `findNearestScrollableContainer`, but each uses a DIFFERENT scrollable
// predicate, and the three have not been shown to agree. Collapsing them is a
// Maestro-conformance change, not a cleanup — left alone deliberately.
function findScrollableAncestorRect(
  node: SnapshotNode,
  byIndex: ReadonlyMap<number, SnapshotNode>,
): Rect | null {
  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  const visited = new Set<number>();
  while (current && !visited.has(current.index)) {
    visited.add(current.index);
    if (current.rect && isScrollableNode(current)) return current.rect;
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
  return null;
}

// fallow-ignore-next-line complexity
function isScrollableNode(node: SnapshotNode): boolean {
  const type = `${node.type ?? ''}`.toLowerCase();
  if (
    type.includes('scroll') ||
    type.includes('recyclerview') ||
    type.includes('listview') ||
    type.includes('gridview') ||
    type.includes('collectionview') ||
    type === 'table'
  ) {
    return true;
  }
  return `${node.role ?? ''} ${node.subrole ?? ''}`.toLowerCase().includes('scroll');
}

function resolveRootViewport(nodes: SnapshotNode[], target: Rect): Rect | null {
  const viewportRects = nodes
    .filter((node) => {
      const type = (node.type ?? '').toLowerCase();
      return node.rect && (type.includes('application') || type.includes('window'));
    })
    .map((node) => node.rect!)
    .sort((left, right) => right.width * right.height - left.width * left.height);
  const centerX = target.x + target.width / 2;
  const centerY = target.y + target.height / 2;
  return (
    viewportRects.find((rect) => containsPoint(rect, centerX, centerY)) ?? viewportRects[0] ?? null
  );
}

function rectsOverlap(left: Rect, right: Rect): boolean {
  return (
    Math.max(left.x, right.x) <= Math.min(left.x + left.width, right.x + right.width) &&
    Math.max(left.y, right.y) <= Math.min(left.y + left.height, right.y + right.height)
  );
}

function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}
