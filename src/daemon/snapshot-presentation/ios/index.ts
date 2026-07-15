import type { RawSnapshotNode } from '../../../kernel/snapshot.ts';
import { collectIosImplicitScrollableActions } from './actions.ts';
import { collectIosPresentationNoiseSuppression } from './noise.ts';
import { collectIosRowPresentation } from './rows.ts';
import {
  reindexSnapshotNodesWithSuppressedParents,
  type SnapshotTreeRuleContext,
} from '../tree.ts';

const IOS_PRESENTATION_RULES: Array<
  (nodes: RawSnapshotNode[], context: SnapshotTreeRuleContext) => void
> = [
  collectIosPresentationNoiseSuppression,
  collectIosImplicitScrollableActions,
  collectIosRowPresentation,
];

export function presentIosInteractiveSnapshot(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  return buildIosInteractiveSnapshotPresentation(nodes).nodes;
}

export type IosInteractiveSnapshotPresentation = {
  nodes: RawSnapshotNode[];
  sourceNodes: ReadonlyMap<number, RawSnapshotNode>;
};

export function buildIosInteractiveSnapshotPresentation(
  nodes: RawSnapshotNode[],
): IosInteractiveSnapshotPresentation {
  if (nodes.length === 0) {
    return { nodes, sourceNodes: new Map() };
  }

  const replacements = new Map<number, RawSnapshotNode>();
  const suppressedIndexes = new Set<number>();

  for (const rule of IOS_PRESENTATION_RULES) {
    rule(nodes, { replacements, suppressedIndexes });
  }

  if (suppressedIndexes.size === 0 && replacements.size === 0) {
    return { nodes, sourceNodes: new Map(nodes.map((node) => [node.index, node])) };
  }

  const presentedSourceNodes = nodes
    .filter((node) => !suppressedIndexes.has(node.index))
    .map((node) => replacements.get(node.index) ?? node);
  const sourceNodes = new Map(presentedSourceNodes.map((node) => [node.index, node]));
  for (const sourceIndex of suppressedIndexes) {
    const replacement = replacements.get(sourceIndex);
    if (replacement) sourceNodes.set(sourceIndex, replacement);
  }
  return {
    nodes: reindexSnapshotNodesWithSuppressedParents(
      presentedSourceNodes,
      suppressedIndexes,
      nodes,
    ),
    sourceNodes,
  };
}
