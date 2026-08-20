import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { collectIosImplicitScrollableActions } from './actions.ts';
import { collectIosPresentationNoiseSuppression } from './noise.ts';
import { collectIosRowPresentation } from './rows.ts';
import { collectIosTransitionPresentation } from './transitions.ts';
import { collectIosWebSemanticPresentation } from './web.ts';
import {
  reindexSnapshotNodesWithSuppressedParents,
  type SnapshotTreeRuleContext,
} from '../tree.ts';

const IOS_PRESENTATION_RULES: Array<
  (nodes: RawSnapshotNode[], context: SnapshotTreeRuleContext) => void
> = [
  // Semantic representatives must be collected before duplicate-label suppression.
  collectIosWebSemanticPresentation,
  collectIosTransitionPresentation,
  collectIosImplicitScrollableActions,
  collectIosRowPresentation,
  collectIosPresentationNoiseSuppression,
];

export function presentIosInteractiveSnapshot(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  return buildIosInteractiveSnapshotPresentation(nodes).nodes;
}

export type IosInteractiveSnapshotPresentation = {
  nodes: RawSnapshotNode[];
  /** Presented node indexes for every source index; suppressed noise maps to an empty list. */
  presentedIndexesBySourceIndex: ReadonlyMap<number, number[]>;
  sourceIndexes: ReadonlyMap<number, number>;
};

export function buildIosInteractiveSnapshotPresentation(
  nodes: RawSnapshotNode[],
): IosInteractiveSnapshotPresentation {
  if (nodes.length === 0) {
    return { nodes, presentedIndexesBySourceIndex: new Map(), sourceIndexes: new Map() };
  }

  const sourceIndexes = new Map(nodes.map((node) => [node.index, node.index]));
  const replacements = new Map<number, RawSnapshotNode>();
  const representativeSourceIndexesBySourceIndex = new Map<number, Set<number>>();
  const semanticRepresentativeIndexes = new Set<number>();
  const sourceNodesByIndex = new Map(nodes.map((node) => [node.index, node]));
  const suppressedIndexes = new Set<number>();
  const ruleContext: SnapshotTreeRuleContext = {
    replacements,
    representativeSourceIndexesBySourceIndex,
    semanticRepresentativeIndexes,
    sourceNodesByIndex,
    suppressedIndexes,
  };

  for (const rule of IOS_PRESENTATION_RULES) {
    rule(nodes, ruleContext);
  }

  if (suppressedIndexes.size === 0 && replacements.size === 0) {
    return {
      nodes,
      presentedIndexesBySourceIndex: new Map(nodes.map((node) => [node.index, [node.index]])),
      sourceIndexes,
    };
  }

  const presentedSourceNodes = nodes
    .filter((node) => !suppressedIndexes.has(node.index))
    .map((node) => replacements.get(node.index) ?? node);
  const presentedNodes = reindexSnapshotNodesWithSuppressedParents(
    presentedSourceNodes,
    suppressedIndexes,
    nodes,
  );
  const presentedIndexBySourceIndex = new Map(
    presentedSourceNodes.map((node, position) => [node.index, presentedNodes[position]!.index]),
  );
  return {
    nodes: presentedNodes,
    presentedIndexesBySourceIndex: new Map(
      nodes.map((node) => [
        node.index,
        resolvePresentedIndexes(
          node.index,
          presentedIndexBySourceIndex,
          representativeSourceIndexesBySourceIndex,
        ),
      ]),
    ),
    sourceIndexes: new Map(
      presentedNodes.map((node, position) => [node.index, presentedSourceNodes[position]!.index]),
    ),
  };
}

function resolvePresentedIndexes(
  sourceIndex: number,
  presentedIndexBySourceIndex: ReadonlyMap<number, number>,
  representativesBySourceIndex: ReadonlyMap<number, ReadonlySet<number>>,
  visited = new Set<number>(),
): number[] {
  const direct = presentedIndexBySourceIndex.get(sourceIndex);
  if (direct !== undefined) return [direct];
  if (visited.has(sourceIndex)) return [];
  visited.add(sourceIndex);
  const resolved = new Set<number>();
  for (const representative of representativesBySourceIndex.get(sourceIndex) ?? []) {
    for (const presentedIndex of resolvePresentedIndexes(
      representative,
      presentedIndexBySourceIndex,
      representativesBySourceIndex,
      visited,
    )) {
      resolved.add(presentedIndex);
    }
  }
  return [...resolved].sort((left, right) => left - right);
}
