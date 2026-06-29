import type { SnapshotNode } from '../../kernel/snapshot.ts';

export function findAncestor(
  node: SnapshotNode,
  nodeIndex: ReadonlyMap<number, SnapshotNode>,
  predicate: (node: SnapshotNode) => boolean,
): SnapshotNode | null {
  let current = node;
  while (typeof current.parentIndex === 'number') {
    const parent = nodeIndex.get(current.parentIndex);
    if (!parent) return null;
    if (predicate(parent)) return parent;
    current = parent;
  }
  return null;
}

export function collectDescendants(nodes: SnapshotNode[], rootIndex: number): SnapshotNode[] {
  const descendants: SnapshotNode[] = [];
  const pending = [rootIndex];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const node of nodes) {
      if (node.parentIndex !== current) continue;
      descendants.push(node);
      pending.push(node.index);
    }
  }
  return descendants;
}

export function markNodeAndDescendantsForRemoval(
  nodes: SnapshotNode[],
  rootIndex: number,
  removed: Set<number>,
): void {
  const pending = [rootIndex];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (removed.has(current)) continue;
    removed.add(current);
    for (const node of nodes) {
      if (node.parentIndex !== current || removed.has(node.index)) continue;
      pending.push(node.index);
    }
  }
}
