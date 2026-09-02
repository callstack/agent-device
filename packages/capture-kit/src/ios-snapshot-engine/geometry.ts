import type { Rect, RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { validateIosSnapshotGraph } from './graph.ts';
import {
  isGeometricallyActionable,
  rootTraversal,
  traversalDecision,
  type BranchState,
  type GeometryDecision,
} from './geometry-policy.ts';
import type {
  IosSnapshotFoldOptions,
  IosSnapshotFoldPolicy,
  IosSnapshotPresentationNode,
  IosSnapshotPresentationStats,
} from './types.ts';

export function foldIosSnapshot(
  nodes: readonly RawSnapshotNode[],
  viewport: Rect,
  interactiveOnly: boolean,
  policy: IosSnapshotFoldPolicy,
  options: IosSnapshotFoldOptions = {},
): { nodes: IosSnapshotPresentationNode[]; stats: IosSnapshotPresentationStats } {
  validateIosSnapshotGraph(nodes);
  const hasChildren = buildChildPresence(nodes);
  const states = new Map<number, BranchState>();
  const kept: IosSnapshotPresentationNode[] = [];
  const hints = new Map<number, { above: boolean; below: boolean }>();
  let parentClipLookups = 0;

  for (const node of nodes) {
    const parentState = readParentState(node, states, () => {
      parentClipLookups += 1;
    });
    const parentTraversal = parentState?.traversal ?? rootTraversal();
    const parentAnchor = policy === 'cursor-projected' ? parentState?.anchor : undefined;
    const decision = traversalDecision(
      node,
      parentTraversal,
      viewport,
      interactiveOnly,
      hasChildren.has(node.index),
      policy,
    );

    recordHiddenContentHint(decision, parentAnchor, hints);
    const foldedNode = appendFoldedNode(node, decision, parentState, kept, viewport, options);
    const anchor = nextScrollAnchor(decision, parentAnchor, foldedNode.keptIndex);
    states.set(node.index, {
      traversal: decision.descendants,
      anchor,
      keptIndex: foldedNode.keptIndex,
      keptDepth: foldedNode.keptDepth,
    });
  }

  const presented = applyHiddenContentHints(hints, kept);
  return {
    nodes: presented,
    stats: {
      presentedNodeCount: presented.length,
      sourceNodeCount: nodes.length,
      parentClipLookups,
    },
  };
}

function buildChildPresence(nodes: readonly RawSnapshotNode[]): Set<number> {
  const parents = new Set<number>();
  for (const node of nodes) {
    if (node.parentIndex !== undefined) parents.add(node.parentIndex);
  }
  return parents;
}

function readParentState(
  node: RawSnapshotNode,
  states: ReadonlyMap<number, BranchState>,
  onLookup: () => void,
): BranchState | undefined {
  if (node.parentIndex === undefined) return undefined;
  onLookup();
  return states.get(node.parentIndex);
}

function recordHiddenContentHint(
  decision: GeometryDecision,
  parentAnchor: BranchState['anchor'],
  hints: Map<number, { above: boolean; below: boolean }>,
): void {
  if (decision.hiddenContentFrame && parentAnchor) {
    rememberHiddenContentHint(decision.hiddenContentFrame, parentAnchor, hints);
  }
}

function appendFoldedNode(
  node: RawSnapshotNode,
  decision: GeometryDecision,
  parentState: BranchState | undefined,
  kept: IosSnapshotPresentationNode[],
  viewport: Rect,
  options: IosSnapshotFoldOptions,
): { keptIndex?: number; keptDepth: number } {
  let keptIndex = parentState?.keptIndex;
  let keptDepth = parentState?.keptDepth ?? -1;
  if (!decision.isIncluded) return { keptIndex, keptDepth };

  const index = kept.length;
  keptDepth += 1;
  const { hittable: sourceHittable, ...sourceNode } = node;
  kept.push({
    raw: {
      ...sourceNode,
      index,
      depth: keptDepth,
      parentIndex: keptIndex,
      ...foldedHittability(
        sourceHittable,
        node.parentIndex !== undefined,
        decision.effectiveRect,
        node.enabled !== false,
        viewport,
        options,
      ),
    },
    sourceIndex: node.index,
    ...(decision.effectiveRect ? { effectiveRect: decision.effectiveRect } : {}),
  });
  keptIndex = index;
  return { keptIndex, keptDepth };
}

function foldedHittability(
  sourceHittable: RawSnapshotNode['hittable'],
  hasParent: boolean,
  effectiveRect: Rect | undefined,
  enabled: boolean,
  viewport: Rect,
  options: IosSnapshotFoldOptions,
): Partial<Pick<RawSnapshotNode, 'hittable'>> {
  if (options.hittabilityAvailable === false) {
    return sourceHittable === false ? { hittable: false } : {};
  }
  return {
    hittable:
      hasParent &&
      sourceHittable === true &&
      isGeometricallyActionable(enabled, effectiveRect, viewport),
  };
}

function nextScrollAnchor(
  decision: GeometryDecision,
  parentAnchor: BranchState['anchor'],
  keptIndex: number | undefined,
): BranchState['anchor'] {
  if (decision.establishesScrollAnchor && keptIndex !== undefined && decision.effectiveRect) {
    return { index: keptIndex, rect: decision.effectiveRect };
  }
  return parentAnchor;
}

function rememberHiddenContentHint(
  frame: Rect,
  anchor: { index: number; rect: Rect },
  hints: Map<number, { above: boolean; below: boolean }>,
): void {
  const hint = hints.get(anchor.index) ?? { above: false, below: false };
  if (frame.y + frame.height <= anchor.rect.y) hint.above = true;
  else if (frame.y >= anchor.rect.y + anchor.rect.height) hint.below = true;
  hints.set(anchor.index, hint);
}

function applyHiddenContentHints(
  hints: ReadonlyMap<number, { above: boolean; below: boolean }>,
  nodes: IosSnapshotPresentationNode[],
): IosSnapshotPresentationNode[] {
  return nodes.map((presentation) => {
    const hint = hints.get(presentation.raw.index);
    if (!hint) return presentation;
    const node = presentation.raw;
    return {
      ...presentation,
      raw: {
        ...node,
        hiddenContentAbove: node.hiddenContentAbove === true || hint.above ? true : undefined,
        hiddenContentBelow: node.hiddenContentBelow === true || hint.below ? true : undefined,
      },
    };
  });
}
