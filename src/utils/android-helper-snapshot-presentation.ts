import type { SnapshotNode } from '../kernel/snapshot.ts';
import { hasRenderableArea } from './android-helper-presentation/geometry.ts';
import { isRootNode, isScrollableNode } from './android-helper-presentation/predicates.ts';
import {
  markAdjacentDuplicateStructuralNodesForRemoval,
  markRepeatedActionRowDescendantsForRemoval,
  markUnlabeledActionRowsForPromotion,
} from './android-helper-presentation/structural-noise.ts';
import {
  findAncestor,
  markNodeAndDescendantsForRemoval,
} from './android-helper-presentation/tree.ts';

export type AndroidHelperPresentationInput = {
  nodes: SnapshotNode[];
  filteredCount: number;
};

export function buildAndroidHelperPresentationInput(
  data: Record<string, unknown>,
  nodes: SnapshotNode[],
  options: { raw?: boolean },
): AndroidHelperPresentationInput {
  if (options.raw || !isAndroidHelperSnapshot(data)) {
    return { nodes, filteredCount: 0 };
  }
  const filtered = filterAndroidHelperTextOutputNodes(nodes);
  return {
    nodes: filtered,
    filteredCount: nodes.length - filtered.length,
  };
}

function isAndroidHelperSnapshot(data: Record<string, unknown>): boolean {
  const metadata = data.androidSnapshot;
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as Record<string, unknown>).backend === 'android-helper';
}

function filterAndroidHelperTextOutputNodes(nodes: SnapshotNode[]): SnapshotNode[] {
  if (nodes.length === 0) return nodes;

  const removed = new Set<number>();
  const replacements = new Map<number, SnapshotNode>();
  const nodeIndex = new Map(nodes.map((node) => [node.index, node]));
  markZeroAreaNodesForRemoval(nodes, removed);
  markRectlessScrollableDescendantsForRemoval(nodes, nodeIndex, removed, replacements);
  markUnlabeledActionRowsForPromotion(nodes, removed, replacements);
  markRepeatedActionRowDescendantsForRemoval(nodes, removed);
  markAdjacentDuplicateStructuralNodesForRemoval(nodes, removed, replacements);

  return nodes
    .filter((node) => !removed.has(node.index))
    .map((node) => replacements.get(node.index) ?? node);
}

function markZeroAreaNodesForRemoval(nodes: SnapshotNode[], removed: Set<number>): void {
  for (const node of nodes) {
    if (!node.rect || hasRenderableArea(node.rect) || isRootNode(node)) {
      continue;
    }
    markNodeAndDescendantsForRemoval(nodes, node.index, removed);
  }
}

function markRectlessScrollableDescendantsForRemoval(
  nodes: SnapshotNode[],
  nodeIndex: ReadonlyMap<number, SnapshotNode>,
  removed: Set<number>,
  replacements: Map<number, SnapshotNode>,
): void {
  for (const node of nodes) {
    if (removed.has(node.index) || node.rect || isRootNode(node)) continue;

    const scrollAncestor = findAncestor(node, nodeIndex, isScrollableNode);
    if (scrollAncestor) {
      addHiddenContentHint(replacements, scrollAncestor, inferRectlessNodeDirection(node, nodes));
    }
    markNodeAndDescendantsForRemoval(nodes, node.index, removed);
  }
}

function inferRectlessNodeDirection(
  node: SnapshotNode,
  nodes: SnapshotNode[],
): 'above' | 'below' | null {
  const renderedSiblingIndexes = nodes
    .filter(
      (candidate) =>
        candidate.parentIndex === node.parentIndex &&
        candidate.rect &&
        hasRenderableArea(candidate.rect),
    )
    .map((candidate) => candidate.index);
  if (renderedSiblingIndexes.length === 0) return null;

  // Android helper rectless children are offscreen list content. UIAutomator
  // traversal order is the only signal left once bounds disappear, so this is
  // intentionally a conservative above/below hint rather than exact geometry.
  if (node.index < Math.min(...renderedSiblingIndexes)) return 'above';
  if (node.index > Math.max(...renderedSiblingIndexes)) return 'below';
  return null;
}

function addHiddenContentHint(
  replacements: Map<number, SnapshotNode>,
  node: SnapshotNode,
  direction: 'above' | 'below' | null,
): void {
  if (!direction) return;
  const existing = replacements.get(node.index) ?? node;
  replacements.set(node.index, {
    ...existing,
    hiddenContentAbove:
      existing.hiddenContentAbove === true || direction === 'above' ? true : undefined,
    hiddenContentBelow:
      existing.hiddenContentBelow === true || direction === 'below' ? true : undefined,
  });
}
