import type { SnapshotNode } from '@agent-device/kernel/snapshot';

export function buildSnapshotNodeMap<T extends { index: number }>(
  nodes: readonly T[],
): Map<number, T> {
  return new Map(nodes.map((node) => [node.index, node]));
}

/**
 * Walks from the given node through its parent chain and returns the first
 * non-null value produced by `resolve`. Returning null from `resolve` skips
 * that ancestor and continues walking toward the root. Parents are resolved
 * by snapshot index (not array position) with an array-offset fallback, and
 * a visited set guards against parent-linkage cycles.
 */
export function findSnapshotAncestor<T>(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  nodeByIndex: ReadonlyMap<number, SnapshotNode>,
  resolve: (ancestor: SnapshotNode) => T | null,
): T | null {
  let current: SnapshotNode | undefined = node;
  const visited = new Set<number>();
  while (typeof current.parentIndex === 'number' && !visited.has(current.index)) {
    visited.add(current.index);
    current = nodeByIndex.get(current.parentIndex) ?? nodes[current.parentIndex];
    if (!current) return null;
    const result = resolve(current);
    if (result !== null) return result;
  }
  return null;
}
