import type { Rect, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { isViewportRootNode, normalizeType } from '@agent-device/contracts/snapshot';
import { hasPositiveRect, rectArea, rectContains, unionRects } from './rects.ts';

/**
 * Android overlay policy (#1983): which Android nodes earn an overlay ref, and what rectangle
 * an overlay for one of them should actually cover.
 *
 * Android reports whole clickable rows as hittable with no role and no label, so both questions
 * need Android-specific answers that the shared ranking pass must not have to know about. The
 * daemon keeps the ranking, projection and artifact assembly; the classification lives here.
 */

// A hittable Android node with none of these types is a plausible unlabeled control. Scroll
// containers, lists and text fields are hittable too, but an overlay over one of them marks a
// region rather than a control.
const ANDROID_UNLABELED_CLICKABLE_EXCLUDED_TYPES = [
  'scroll',
  'list',
  'recyclerview',
  'edittext',
  'textfield',
] as const;

/**
 * Whether an Android node qualifies as an unlabeled clickable overlay source. A node larger
 * than a quarter of the snapshot bounds is treated as layout, not as a control.
 */
export function isAndroidUnlabeledClickableSource(
  snapshot: SnapshotState,
  snapshotBounds: Rect | null,
  node: SnapshotNode,
): boolean {
  if (snapshot.backend !== 'android') return false;
  if (!node.hittable || !hasPositiveRect(node.rect) || isViewportRootNode(node)) return false;
  const normalizedType = normalizeType(node.type ?? '');
  if (ANDROID_UNLABELED_CLICKABLE_EXCLUDED_TYPES.some((type) => normalizedType.includes(type))) {
    return false;
  }
  if (snapshotBounds && rectArea(node.rect) > rectArea(snapshotBounds) * 0.25) return false;
  return true;
}

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
