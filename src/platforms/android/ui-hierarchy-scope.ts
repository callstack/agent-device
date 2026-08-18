import {
  findSnapshotScopeRange,
  reindexSnapshotNodes,
  type SnapshotScopeCandidate,
} from '@agent-device/contracts/snapshot';

type PresentedNode = SnapshotScopeCandidate & {
  index: number;
  depth?: number;
  parentIndex?: number;
};

/** Presented nodes with the parsed source node behind each, index-parallel. */
export type AndroidPresentedNodes<Node extends PresentedNode, Source> = {
  nodes: Node[];
  sourceNodes: Source[];
};

/**
 * The scope specification (`@agent-device/contracts/snapshot`), applied to the PRESENTED nodes of
 * the requested projection: first document-order match among nodes membership kept, its subtree
 * re-rooted at depth 0, empty on no match. This is the ONLY scope pass an Android snapshot goes
 * through — the daemon's post-wire `scopeSnapshotNodes` skips the android backend — and it runs
 * after the walk so ancestor context (hittable / collection / chrome) above the scope root still
 * shapes membership inside it. `sourceNodes` stay parallel to `nodes` for hint bridging.
 */
export function scopePresentedAndroidSnapshot<Node extends PresentedNode, Source>(
  state: AndroidPresentedNodes<Node, Source>,
  scope: string,
  maxDepth: number,
): AndroidPresentedNodes<Node, Source> {
  const range = findSnapshotScopeRange(state.nodes, scope);
  if (!range) return { nodes: [], sourceNodes: [] };
  const rootDepth = state.nodes[range.start]?.depth ?? 0;
  const positions: number[] = [];
  for (let position = range.start; position < range.end; position += 1) {
    if ((state.nodes[position]?.depth ?? 0) - rootDepth <= maxDepth) positions.push(position);
  }
  return {
    nodes: reindexSnapshotNodes(
      positions.map((position) => state.nodes[position] as Node),
      rootDepth,
    ),
    sourceNodes: positions.map((position) => state.sourceNodes[position] as Source),
  };
}
