import {
  matchesSnapshotScope,
  reindexSnapshotNodes,
  type SnapshotScopeCandidate,
} from '@agent-device/contracts/snapshot';

type PresentedNode = { index: number; depth?: number; parentIndex?: number };
type SourceNode = SnapshotScopeCandidate & { depth: number; children: SourceNode[] };

/** Presented nodes with the acquired node behind each, index-parallel. */
export type AndroidPresentedNodes<Node extends PresentedNode, Source> = {
  nodes: Node[];
  sourceNodes: Source[];
};

/**
 * The scope specification (`@agent-device/contracts/snapshot`) as it applies to a projection that
 * drops nodes: **the scope root is the first node in document order that matches AND whose subtree
 * contributes at least one node to the requested projection**; the result is that subtree's
 * presented nodes, re-rooted at depth 0. No match, or no candidate with presented content, yields
 * an empty snapshot.
 *
 * Both halves of that rule are load-bearing, and each fixes a real capture:
 * - matching the acquired tree alone empties `-i --scope "Settings"` when the first "Settings" is a
 *   decorative heading membership drops;
 * - matching only presented nodes empties `-i --scope panel` when the panel is a structural
 *   container membership drops — even though the Save button inside it is exactly what was asked
 *   for. Requiring presented CONTENT rather than a presented ROOT keeps that button.
 *
 * `--depth` under scope filters the depths the response actually EMITS, rebased so the shallowest
 * presented node of the subtree sits at 0: a snapshot that prints `Save` at depth 0 must not hide
 * it at `--depth 0`. (Without a scope, `--depth` still cuts the walk by acquired tree depth, which
 * can differ from the compacted depth printed beside each node — pre-existing, tracked on #1832.)
 * `reindexSnapshotNodes` drops parent links that pointed outside the slice.
 *
 * This is the ONLY scope pass an Android snapshot goes through — the daemon's post-wire
 * `scopeSnapshotNodes` skips the android backend — and it runs after the walk, so ancestor context
 * above the scope root (hittable / collection / chrome) still shapes membership inside it.
 * `sourceNodes` stay parallel to `nodes` for hint bridging.
 */
export function scopePresentedAndroidSnapshot<
  Node extends PresentedNode,
  Source extends SourceNode,
>(
  state: AndroidPresentedNodes<Node, Source>,
  roots: readonly Source[],
  scope: string,
  maxDepth: number,
): AndroidPresentedNodes<Node, Source> {
  const presented = new Set<Source>(state.sourceNodes);
  const scopeRoot = findAndroidScopeRoot(roots, scope, presented);
  if (!scopeRoot) return { nodes: [], sourceNodes: [] };

  const inScope = collectSubtree(scopeRoot);
  const subtree = [...state.sourceNodes.entries()]
    .filter(([, source]) => inScope.has(source))
    .map(([position]) => position);
  if (subtree.length === 0) return { nodes: [], sourceNodes: [] };

  const depthOffset = Math.min(...subtree.map((position) => state.nodes[position]?.depth ?? 0));
  const positions = subtree.filter(
    (position) => (state.nodes[position]?.depth ?? 0) - depthOffset <= maxDepth,
  );
  return {
    nodes: reindexSnapshotNodes(
      positions.map((position) => state.nodes[position] as Node),
      depthOffset,
    ),
    sourceNodes: positions.map((position) => state.sourceNodes[position] as Source),
  };
}

/** First document-order match whose subtree contributes presented content. */
function findAndroidScopeRoot<Source extends SourceNode>(
  roots: readonly Source[],
  scope: string,
  presented: ReadonlySet<Source>,
): Source | null {
  for (const node of documentOrder(roots)) {
    if (matchesSnapshotScope(node, scope) && subtreeHasPresentedNode(node, presented)) return node;
  }
  return null;
}

function* documentOrder<Source extends SourceNode>(roots: readonly Source[]): Generator<Source> {
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as Source;
    yield node;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index] as Source);
    }
  }
}

function subtreeHasPresentedNode<Source extends SourceNode>(
  root: Source,
  presented: ReadonlySet<Source>,
): boolean {
  for (const node of documentOrder([root])) {
    if (presented.has(node)) return true;
  }
  return false;
}

function collectSubtree<Source extends SourceNode>(root: Source): ReadonlySet<Source> {
  return new Set(documentOrder([root]));
}
