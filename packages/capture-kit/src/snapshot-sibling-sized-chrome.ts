import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { areRectsApproximatelyEqual, normalizeRect } from '@agent-device/kernel/rect-center';
import { isViewportChromeNode } from './snapshot-chrome-kind.ts';

/** One-tree context for classifying a node's neighbours without rescanning the whole snapshot. */
export type SiblingChromeNeighbourhood = {
  childrenByParent: ReadonlyMap<number, RawSnapshotNode[]>;
};

export function collectSiblingChromeNeighbourhood(
  nodes: readonly RawSnapshotNode[],
): SiblingChromeNeighbourhood {
  const childrenByParent = new Map<number, RawSnapshotNode[]>();
  for (const node of nodes) {
    if (typeof node.parentIndex !== 'number') continue;
    const siblings = childrenByParent.get(node.parentIndex);
    if (siblings) siblings.push(node);
    else childrenByParent.set(node.parentIndex, [node]);
  }
  return { childrenByParent };
}

/**
 * Whether a viewport-chrome container (`tabbar`/`toolbar`/`navigationbar`) is published with exactly
 * the frame of a sibling. UIKit sizes such a container to the subtree it presents over, so a
 * sibling-matching frame is the container's host footprint rather than a surface drawn over that
 * sibling: what the container really draws is its descendants, each with its own smaller rect. The
 * occlusion pass must not read the host's own box as covering evidence (#2996).
 *
 * Only chrome kinds qualify — a `dialog`/`sheet`/`alert` sized to the content around it is a real
 * presentation over that content and keeps covering. The candidate is matched against the siblings
 * listed under its own parent, never against same-size rects elsewhere in the tree.
 */
export function isSiblingSizedChromeContainer(
  node: RawSnapshotNode,
  neighbourhood: SiblingChromeNeighbourhood,
): boolean {
  if (!isViewportChromeNode(node)) return false;
  if (typeof node.parentIndex !== 'number') return false;
  const rect = siblingComparableRect(node.rect);
  if (!rect) return false;
  const siblings = neighbourhood.childrenByParent.get(node.parentIndex) ?? [];
  return siblings.some(
    (sibling) =>
      sibling.index !== node.index &&
      areRectsApproximatelyEqual(rect, siblingComparableRect(sibling.rect)),
  );
}

/** The occlusion pass's own usability test for a rect, so both files accept the same frames. */
function siblingComparableRect(rect: RawSnapshotNode['rect']): Rect | undefined {
  const normalized = normalizeRect(rect);
  return normalized && normalized.width > 0 && normalized.height > 0 ? normalized : undefined;
}
