import {
  matchesSnapshotScope,
  reindexSnapshotNodes,
  type SnapshotScopeCandidate,
} from '@agent-device/contracts/snapshot';
import type { AndroidSnapshotPresentationBudget } from './snapshot-presentation.ts';

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
 * This is the ONLY scope pass an Android snapshot goes through — the daemon never reapplies scope
 * after the wire — and it runs after the walk, so ancestor context above the scope root (hittable /
 * collection / chrome) still shapes membership inside it.
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
  budget: AndroidSnapshotPresentationBudget,
): AndroidPresentedNodes<Node, Source> {
  const presented = new Set<Source>(state.sourceNodes);
  const order = collectDocumentOrder(roots, budget);
  const contributing = collectPresentedSubtrees(order, presented, budget);
  const scopeRoot = findAndroidScopeRoot(order, scope, contributing, budget);
  if (!scopeRoot) return { nodes: [], sourceNodes: [] };

  const inScope = new Set(collectDocumentOrder([scopeRoot], budget));
  const subtree: number[] = [];
  for (const [position, source] of state.sourceNodes.entries()) {
    budget.check('work');
    if (inScope.has(source)) subtree.push(position);
  }
  if (subtree.length === 0) return { nodes: [], sourceNodes: [] };

  let depthOffset = Number.POSITIVE_INFINITY;
  for (const position of subtree) {
    budget.check('work');
    depthOffset = Math.min(depthOffset, state.nodes[position]?.depth ?? 0);
  }
  const positions: number[] = [];
  for (const position of subtree) {
    budget.check('work');
    if ((state.nodes[position]?.depth ?? 0) - depthOffset <= maxDepth) positions.push(position);
  }
  budget.consume(positions.length);
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
  order: readonly Source[],
  scope: string,
  contributing: ReadonlySet<Source>,
  budget: AndroidSnapshotPresentationBudget,
): Source | null {
  for (const node of order) {
    budget.check('work');
    if (matchesSnapshotScope(node, scope) && contributing.has(node)) return node;
  }
  return null;
}

function collectDocumentOrder<Source extends SourceNode>(
  roots: readonly Source[],
  budget: AndroidSnapshotPresentationBudget,
): Source[] {
  const order: Source[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    budget.check('work');
    const node = stack.pop() as Source;
    order.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      budget.check('work');
      stack.push(node.children[index] as Source);
    }
  }
  return order;
}

function collectPresentedSubtrees<Source extends SourceNode>(
  order: readonly Source[],
  presented: ReadonlySet<Source>,
  budget: AndroidSnapshotPresentationBudget,
): ReadonlySet<Source> {
  const contributing = new Set<Source>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    budget.check('work');
    const node = order[index] as Source;
    if (presented.has(node)) {
      contributing.add(node);
      continue;
    }
    for (const child of node.children) {
      budget.check('work');
      if (contributing.has(child as Source)) {
        contributing.add(node);
        break;
      }
    }
  }
  return contributing;
}
