import type { SnapshotNode } from '@agent-device/kernel/snapshot';

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

/** Children in node-array order, keyed by `parentIndex`; roots sit under `undefined`. */
export type ChildrenByParent = ReadonlyMap<number | undefined, readonly SnapshotNode[]>;

export function buildChildrenByParent(nodes: readonly SnapshotNode[]): ChildrenByParent {
  const children = new Map<number | undefined, SnapshotNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentIndex);
    if (siblings) siblings.push(node);
    else children.set(node.parentIndex, [node]);
  }
  return children;
}

export function collectDescendants(children: ChildrenByParent, rootIndex: number): SnapshotNode[] {
  const descendants: SnapshotNode[] = [];
  const visited = new Set<number>([rootIndex]);
  const pending = [rootIndex];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const node of children.get(current) ?? []) {
      if (visited.has(node.index)) continue;
      visited.add(node.index);
      descendants.push(node);
      pending.push(node.index);
    }
  }
  return descendants;
}

export function markNodeAndDescendantsForRemoval(
  children: ChildrenByParent,
  rootIndex: number,
  removed: Set<number>,
): void {
  const pending = [rootIndex];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (removed.has(current)) continue;
    removed.add(current);
    for (const node of children.get(current) ?? []) {
      if (!removed.has(node.index)) pending.push(node.index);
    }
  }
}
