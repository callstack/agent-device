/**
 * Snapshot scope specification (`snapshot --scope <text>`), one rule for every presentation
 * runtime (#1797 / #1832):
 *
 * - a node matches when its label, value, or identifier contains the scope text,
 *   case-insensitively;
 * - the scope root is the first match in document (pre-)order whose subtree contributes at least
 *   one node to the requested projection — so a decorative match membership drops does not empty
 *   the snapshot, and a container membership drops still scopes to the content inside it;
 * - the scoped snapshot is that root's presented subtree, re-rooted at depth 0 and reindexed;
 * - no match yields an EMPTY snapshot — never the full tree.
 *
 * The golden table `contracts/fixtures/snapshot-scope-policy.json` pins the rule; the Android
 * projection and Swift runner are asserted against the same table so drift turns CI red on
 * whichever side changed.
 */
export type SnapshotScopeCandidate = {
  label?: string | null;
  value?: string | null;
  identifier?: string | null;
};

export function normalizeSnapshotScope(scope: string | undefined): string | null {
  const query = scope?.trim().toLowerCase();
  return query ? query : null;
}

export function matchesSnapshotScope(node: SnapshotScopeCandidate, scope: string): boolean {
  const query = normalizeSnapshotScope(scope);
  if (!query) return false;
  return [node.label, node.value, node.identifier].some((field) =>
    (field ?? '').toLowerCase().includes(query),
  );
}

/**
 * Positions `[start, end)` of the scope root's subtree in a document-order node list, or `null`
 * when nothing matches. The subtree is the root plus every following node deeper than it.
 */
export function findSnapshotScopeRange(
  nodes: readonly (SnapshotScopeCandidate & { depth?: number })[],
  scope: string,
  subtreeContributes: (range: { start: number; end: number }) => boolean = () => true,
): { start: number; end: number } | null {
  if (!normalizeSnapshotScope(scope)) return null;
  for (const [start, node] of nodes.entries()) {
    if (!matchesSnapshotScope(node, scope)) continue;
    const rootDepth = node.depth ?? 0;
    let end = start + 1;
    while (end < nodes.length && (nodes[end]?.depth ?? 0) > rootDepth) end += 1;
    const range = { start, end };
    if (subtreeContributes(range)) return range;
  }
  return null;
}

/** Re-roots a document-order slice: fresh indexes, remapped parents, depth rebased by `depthOffset`. */
export function reindexSnapshotNodes<
  T extends { index: number; depth?: number; parentIndex?: number },
>(nodes: readonly T[], depthOffset = 0): T[] {
  const indexMap = new Map<number, number>();
  for (const [index, node] of nodes.entries()) indexMap.set(node.index, index);
  return nodes.map((node, index) => ({
    ...node,
    index,
    depth: Math.max(0, (node.depth ?? 0) - depthOffset),
    parentIndex: typeof node.parentIndex === 'number' ? indexMap.get(node.parentIndex) : undefined,
  }));
}
