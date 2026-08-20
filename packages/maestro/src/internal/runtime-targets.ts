import type { Rect, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import type { MaestroSelector } from './program-ir.ts';
import type { MaestroPlatform } from './runtime-target-policy.ts';
import {
  matchMaestroCandidatesWithResolver,
  rankMaestroCandidates,
  rankVisibleMaestroMatches,
  selectMaestroSnapshotMatch,
  selectMaestroSnapshotNode,
  usableRect,
  type MaestroRankedCandidates,
} from './runtime-target-ranking.ts';
import { createMaestroSnapshotResolver } from './runtime-selector-resolution.ts';
import { pointInsideRect, stripUndefined } from './shared.ts';
import { isMaestroNodeVisible } from './snapshot-policy.ts';
import { buildSnapshotNodeMap } from '@agent-device/contracts/snapshot';
import { hasMaestroRecursiveRelations as hasRecursiveRelations } from './selector-relations.ts';

export type MaestroTargetQuery = {
  selector: MaestroSelector;
  allowAtomicSelectorDispatch?: boolean;
};

export type MaestroTargetEvidence = {
  selector: MaestroSelector;
  matched: boolean;
  visible: boolean;
  candidateCount: number;
  ref?: string;
};

type MaestroInteractivePresentation = {
  snapshot: SnapshotState;
  presentedIndexesBySourceIndex: ReadonlyMap<number, readonly number[]>;
};

export type MaestroTargetResolution =
  | {
      ok: true;
      node: SnapshotNode;
      rect: Rect;
      matches: number;
      dispatchCandidates: number;
      evidence: MaestroTargetEvidence;
    }
  | { ok: false; message: string; evidence: MaestroTargetEvidence };

export function resolveMaestroTargetFromSnapshot(
  snapshot: SnapshotState,
  query: MaestroTargetQuery,
  platform: MaestroPlatform,
  options: {
    interactiveBounds?: boolean;
    presentation?: MaestroInteractivePresentation;
  } = {},
): MaestroTargetResolution {
  const presentedNodes =
    platform === 'ios' && options.presentation
      ? createPresentedNodeLookup(options.presentation)
      : undefined;
  const candidates = presentedNodes
    ? rankPresentedMaestroCandidates(snapshot, query, presentedNodes)
    : rankMaestroCandidates(snapshot, query.selector, platform);
  if (!candidates.parentMatched) {
    return {
      ok: false,
      message: 'Maestro childOf parent did not match.',
      evidence: buildMaestroTargetEvidence(query, candidates.matches, [], undefined),
    };
  }
  const { matches, ranked: rankedMatches } = candidates;
  const target = presentedNodes
    ? selectMaestroSnapshotNode(rankedMatches, query.selector.index)
    : selectMaestroSnapshotMatch(rankedMatches, query.selector.index)?.node;
  const evidence = buildMaestroTargetEvidence(query, matches, rankedMatches, target);
  if (!target) {
    return failedTargetResolution(query, matches, rankedMatches, evidence);
  }
  const presentedTarget = presentedNodes
    ? selectMaestroSnapshotMatch(presentedNodes.visibleForSource(target), undefined)
    : null;
  const semanticRect = usableRect(target);
  const rect = options.interactiveBounds
    ? (presentedTarget?.rect ?? semanticRect)
    : (semanticRect ?? presentedTarget?.rect);
  if (!rect) return failedTargetResolution(query, matches, rankedMatches, evidence);

  return {
    ok: true,
    node: target,
    rect,
    matches: rankedMatches.length,
    dispatchCandidates:
      platform === 'ios' &&
      query.allowAtomicSelectorDispatch &&
      !hasMaestroRecursiveRelations(query.selector) &&
      presentedNodes
        ? countInteractionDispatchCandidates(semanticRect, rankedMatches, presentedTarget)
        : 0,
    evidence,
  };
}

export const hasMaestroRecursiveRelations = hasRecursiveRelations;

function createPresentedNodeLookup(presentation: MaestroInteractivePresentation): {
  isVisible: (node: SnapshotNode) => boolean;
  visibleForSource: (node: SnapshotNode) => SnapshotNode[];
} {
  const presentedByIndex = buildSnapshotNodeMap(presentation.snapshot.nodes);
  const visibleBySourceIndex = new Map<number, SnapshotNode[]>();
  const forSource = (semanticNode: SnapshotNode): SnapshotNode[] => {
    return (presentation.presentedIndexesBySourceIndex.get(semanticNode.index) ?? []).flatMap(
      (presentedIndex) => {
        const node = presentedByIndex.get(presentedIndex);
        return node ? [node] : [];
      },
    );
  };
  const visibleForSource = (node: SnapshotNode): SnapshotNode[] => {
    const cached = visibleBySourceIndex.get(node.index);
    if (cached) return cached;
    const visible = forSource(node).filter((presentedNode) =>
      isMaestroNodeVisible(presentedNode, presentation.snapshot.nodes, 'ios'),
    );
    visibleBySourceIndex.set(node.index, visible);
    return visible;
  };
  return { visibleForSource, isVisible: (node) => visibleForSource(node).length > 0 };
}

function rankPresentedMaestroCandidates(
  snapshot: SnapshotState,
  query: MaestroTargetQuery,
  presentedNodes: ReturnType<typeof createPresentedNodeLookup>,
): MaestroRankedCandidates {
  const resolver = createMaestroSnapshotResolver(snapshot);
  const scoped = matchMaestroCandidatesWithResolver(query.selector, resolver);
  const visible = scoped.matches.filter(presentedNodes.isVisible);
  return {
    ...scoped,
    visible,
    ranked: rankVisibleMaestroMatches(
      snapshot.nodes,
      visible,
      query.selector,
      'ios',
      resolver.nodeByIndex,
    ),
  };
}

function failedTargetResolution(
  query: MaestroTargetQuery,
  matches: SnapshotNode[],
  rankedMatches: SnapshotNode[],
  evidence: MaestroTargetEvidence,
): MaestroTargetResolution {
  if (matches.length > 0 && rankedMatches.length === 0) {
    return {
      ok: false,
      message: `Maestro selector matched ${matches.length} element(s), but none were visible.`,
      evidence,
    };
  }
  const index = query.selector.index === undefined ? '' : ` index ${query.selector.index}`;
  return { ok: false, message: `Maestro selector did not match${index}.`, evidence };
}

function countInteractionDispatchCandidates(
  semanticRect: Rect | undefined,
  rankedCandidates: SnapshotNode[],
  presentedTarget: { node: SnapshotNode; rect: Rect } | null,
): number {
  if (rankedCandidates.length !== 1) return rankedCandidates.length;
  return semanticRect &&
    presentedTarget &&
    presentedTarget.node.hittable !== false &&
    haveSameTapPoint(presentedTarget.rect, semanticRect)
    ? 1
    : 0;
}

function haveSameTapPoint(left: Rect, right: Rect): boolean {
  const leftPoint = pointInsideRect(left);
  const rightPoint = pointInsideRect(right);
  return leftPoint.x === rightPoint.x && leftPoint.y === rightPoint.y;
}

function buildMaestroTargetEvidence(
  query: MaestroTargetQuery,
  matches: SnapshotNode[],
  visibleMatches: SnapshotNode[],
  target: SnapshotNode | undefined,
): MaestroTargetEvidence {
  return stripUndefined({
    selector: query.selector,
    matched: matches.length > 0,
    visible: visibleMatches.length > 0,
    candidateCount: matches.length,
    ref: target?.ref,
  });
}
