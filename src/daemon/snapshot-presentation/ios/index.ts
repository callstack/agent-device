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
  /** Canonical presented representatives for every semantic source index; pure noise maps to []. */
  presentedIndexesBySourceIndex: ReadonlyMap<number, readonly number[]>;
};

export function buildIosInteractiveSnapshotPresentation(
  nodes: RawSnapshotNode[],
): IosInteractiveSnapshotPresentation {
  if (nodes.length === 0) {
    return { nodes, presentedIndexesBySourceIndex: new Map() };
  }

  const replacements = new Map<number, RawSnapshotNode>();
  const representativeSourceIndexesBySourceIndex = new Map<number, Set<number>>();
  const semanticRepresentativeIndexes = new Set<number>();
  const sourceNodesByIndex = new Map(nodes.map((node) => [node.index, node]));
  const suppressedIndexes = new Set<number>();
  const ruleContext: SnapshotTreeRuleContext = {
    replacements,
    semanticRepresentativeIndexes,
    sourceNodesByIndex,
    isSuppressed: (node) => suppressedIndexes.has(node.index),
    suppressNode(source, representatives) {
      suppressedIndexes.add(source.index);
      if (representatives.length === 0) return;
      const indexes =
        representativeSourceIndexesBySourceIndex.get(source.index) ?? new Set<number>();
      for (const representative of representatives) indexes.add(representative.index);
      representativeSourceIndexesBySourceIndex.set(source.index, indexes);
    },
  };

  for (const rule of IOS_PRESENTATION_RULES) {
    rule(nodes, ruleContext);
  }

  if (suppressedIndexes.size === 0 && replacements.size === 0) {
    return {
      nodes,
      presentedIndexesBySourceIndex: new Map(nodes.map((node) => [node.index, [node.index]])),
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
