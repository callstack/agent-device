import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';

export function normalizeSnapshotTree(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  const originalToNormalizedIndex = new Map<number, number>();
  for (const [position, node] of nodes.entries()) {
    originalToNormalizedIndex.set(node.index, position);
  }

  const normalized: RawSnapshotNode[] = [];
  const ancestorStack: Array<{ depth: number; index: number }> = [];

  for (const [position, node] of nodes.entries()) {
    const depth = Math.max(0, node.depth ?? 0);
    while (ancestorStack.length > 0 && depth <= ancestorStack[ancestorStack.length - 1]!.depth) {
      ancestorStack.pop();
    }

    const index = position;
    const explicitParentIndex =
      typeof node.parentIndex === 'number'
        ? originalToNormalizedIndex.get(node.parentIndex)
        : undefined;
    const parentIndex =
      typeof explicitParentIndex === 'number' && explicitParentIndex < index
        ? explicitParentIndex
        : ancestorStack[ancestorStack.length - 1]?.index;
    normalized.push({
      ...node,
      index,
      depth,
      parentIndex,
    });
    ancestorStack.push({ depth, index });
  }

  return normalized;
}

export function displayNodeLabel(node: SnapshotNode): string {
  return node.label?.trim() || node.value?.trim() || node.identifier?.trim() || '';
}
