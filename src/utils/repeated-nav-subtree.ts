import type { Rect, SnapshotNode } from '../kernel/snapshot.ts';
import { normalizeRepeatedNodeLabel } from '../snapshot/snapshot-label-signals.ts';
import { displayNodeLabel } from '../snapshot/snapshot-tree.ts';

export function detectPossibleRepeatedNavSubtree(nodes: SnapshotNode[]): boolean {
  if (nodes.length < 20) {
    return false;
  }
  const groups = new Map<string, SnapshotNode[]>();
  for (const node of nodes) {
    const type = (node.type ?? '').toLowerCase();
    const label = normalizeRepeatedNodeLabel(displayNodeLabel(node));
    if (!label) continue;
    const signature = `${type}|${label}`;
    const group = groups.get(signature) ?? [];
    group.push(node);
    groups.set(signature, group);
  }
  let duplicateCount = 0;
  for (const group of groups.values()) {
    if (group.length <= 1 || !hasOverlappingDuplicateRects(group)) {
      continue;
    }
    duplicateCount += group.length;
  }
  return duplicateCount >= 8;
}

function hasOverlappingDuplicateRects(nodes: SnapshotNode[]): boolean {
  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      if (rectsOverlap(nodes[left]?.rect, nodes[right]?.rect)) {
        return true;
      }
    }
  }
  return false;
}

function rectsOverlap(left: Rect | undefined, right: Rect | undefined): boolean {
  if (!left || !right) {
    return true;
  }
  const tolerance = 0.5;
  return !(
    left.x + left.width <= right.x + tolerance ||
    right.x + right.width <= left.x + tolerance ||
    left.y + left.height <= right.y + tolerance ||
    right.y + right.height <= left.y + tolerance
  );
}
