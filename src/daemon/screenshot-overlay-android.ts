import type { Rect, SnapshotNode } from '../kernel/snapshot.ts';
import { normalizeType } from '../snapshot/snapshot-processing.ts';
import { hasPositiveRect, rectContains, unionRects } from './screenshot-overlay-rects.ts';

export function resolveAndroidOverlaySourceRect(
  target: SnapshotNode,
  nodes: SnapshotNode[],
  hasActionableRole: (node: SnapshotNode) => boolean,
  hasOverlayLabel: (node: SnapshotNode) => boolean,
): Rect | null {
  if (
    !target.rect ||
    target.hittable !== true ||
    hasActionableRole(target) ||
    hasOverlayLabel(target)
  ) {
    return null;
  }
  return balanceAndroidActionRowRect(target, nodes, hasOverlayLabel);
}

function balanceAndroidActionRowRect(
  target: SnapshotNode,
  nodes: SnapshotNode[],
  hasOverlayLabel: (node: SnapshotNode) => boolean,
): Rect | null {
  const targetRect = target.rect!;
  const contentRect = measureAndroidActionRowContentRect(target, nodes, hasOverlayLabel);
  if (!contentRect) return null;

  const topPadding = contentRect.y - targetRect.y;
  const bottomPadding = targetRect.y + targetRect.height - (contentRect.y + contentRect.height);
  if (topPadding < 0 || bottomPadding < 0) return null;
  if (Math.abs(bottomPadding - topPadding) < 16) return null;

  const balancedPadding = Math.min(topPadding, bottomPadding);
  const y = Math.round(contentRect.y - balancedPadding);
  const height = Math.round(contentRect.height + balancedPadding * 2);
  if (height <= 0 || height >= targetRect.height) return null;

  return {
    x: targetRect.x,
    y,
    width: targetRect.width,
    height,
  };
}

function measureAndroidActionRowContentRect(
  target: SnapshotNode,
  nodes: SnapshotNode[],
  hasOverlayLabel: (node: SnapshotNode) => boolean,
): Rect | null {
  const targetRect = target.rect!;
  const nodeIndex = new Map(nodes.map((node) => [node.index, node]));
  const contentRects = nodes
    .filter(
      (node) =>
        node.ref !== target.ref &&
        isDescendantOf(node, target, nodeIndex) &&
        isAndroidActionRowVisualContent(node, hasOverlayLabel) &&
        hasPositiveRect(node.rect) &&
        rectContains(targetRect, node.rect),
    )
    .map((node) => node.rect!);
  if (contentRects.length < 2) return null;
  return unionRects(contentRects);
}

function isAndroidActionRowVisualContent(
  node: SnapshotNode,
  hasOverlayLabel: (node: SnapshotNode) => boolean,
): boolean {
  const normalizedType = normalizeType(node.type ?? '');
  return (
    normalizedType.includes('text') || (normalizedType.includes('image') && hasOverlayLabel(node))
  );
}

function isDescendantOf(
  node: SnapshotNode,
  ancestor: SnapshotNode,
  nodeIndex: ReadonlyMap<number, SnapshotNode>,
): boolean {
  let current = node;
  while (current.parentIndex !== undefined) {
    const parent = nodeIndex.get(current.parentIndex);
    if (!parent) return false;
    if (parent.ref === ancestor.ref) return true;
    current = parent;
  }
  return false;
}
