import type { RawSnapshotNode, SnapshotCaptureBackend } from '@agent-device/kernel/snapshot';
import { collectIosImplicitScrollableActions } from './actions.ts';
import { collectIosPresentationNoiseSuppression } from './noise.ts';
import { collectIosRowPresentation } from './rows.ts';
import { collectIosWebSemanticPresentation } from './web.ts';
import { collectIosViewportPresentation } from './viewport.ts';
import {
  reindexSnapshotNodesWithSuppressedParents,
  type SnapshotTreeRuleContext,
} from '../tree.ts';

const IOS_PRESENTATION_RULES: Array<
  (nodes: RawSnapshotNode[], context: SnapshotTreeRuleContext) => void
> = [
  // Semantic representatives must be collected before duplicate-label suppression.
  collectIosWebSemanticPresentation,
  collectIosImplicitScrollableActions,
  collectIosRowPresentation,
  collectIosPresentationNoiseSuppression,
];

export function presentIosInteractiveSnapshot(
  nodes: RawSnapshotNode[],
  captureBackend?: SnapshotCaptureBackend,
): RawSnapshotNode[] {
  return buildIosInteractiveSnapshotPresentation(nodes, captureBackend).nodes;
}

export type IosInteractiveSnapshotPresentation = {
  nodes: RawSnapshotNode[];
  sourceIndexes: ReadonlyMap<number, number>;
};

export function buildIosInteractiveSnapshotPresentation(
  nodes: RawSnapshotNode[],
  captureBackend?: SnapshotCaptureBackend,
): IosInteractiveSnapshotPresentation {
  if (nodes.length === 0) {
    return { nodes, sourceIndexes: new Map() };
  }

  const sourceIndexes = new Map(nodes.map((node) => [node.index, node.index]));
  const semanticPresentation = applyIosPresentationPass(nodes, sourceIndexes, captureBackend, true);
  return applyIosPresentationPass(
    semanticPresentation.nodes,
    semanticPresentation.sourceIndexes,
    captureBackend,
    false,
  );
}

function applyIosPresentationPass(
  nodes: RawSnapshotNode[],
  sourceIndexes: ReadonlyMap<number, number>,
  captureBackend: SnapshotCaptureBackend | undefined,
  includeSemanticRules: boolean,
): IosInteractiveSnapshotPresentation {
  const replacements = new Map<number, RawSnapshotNode>();
  const semanticRepresentativeIndexes = new Set<number>();
  const sourceNodesByIndex = new Map(nodes.map((node) => [node.index, node]));
  const suppressedIndexes = new Set<number>();
  const ruleContext: SnapshotTreeRuleContext = {
    replacements,
    semanticRepresentativeIndexes,
    sourceNodesByIndex,
    suppressedIndexes,
  };

  collectIosViewportPresentation(nodes, ruleContext, captureBackend);
  if (includeSemanticRules) {
    for (const rule of IOS_PRESENTATION_RULES) {
      rule(nodes, ruleContext);
    }
  }

  if (suppressedIndexes.size === 0 && replacements.size === 0) {
    return { nodes, sourceIndexes };
  }

  const presentedSourceNodes = nodes
    .filter((node) => !suppressedIndexes.has(node.index))
    .map((node) => replacements.get(node.index) ?? node);
  const presentedNodes = reindexSnapshotNodesWithSuppressedParents(
    presentedSourceNodes,
    suppressedIndexes,
    nodes,
  );
  return {
    nodes: presentedNodes,
    sourceIndexes: new Map(
      presentedNodes.map((node, position) => [
        node.index,
        sourceIndexes.get(presentedSourceNodes[position]!.index)!,
      ]),
    ),
  };
}
