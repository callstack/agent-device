export function buildSnapshotNodeMap<T extends { index: number }>(
  nodes: readonly T[],
): Map<number, T> {
  return new Map(nodes.map((node) => [node.index, node]));
}
