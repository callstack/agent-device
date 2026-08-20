import type { Rect, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import type { MaestroSelector } from './program-ir.ts';
import type { MaestroPlatform } from './runtime-target-policy.ts';
import {
  matchMaestroCandidates,
  rankMaestroCandidates,
  rankVisibleMaestroMatches,
  selectMaestroSnapshotMatch,
} from './runtime-target-ranking.ts';
import { pointInsideRect, stripUndefined } from './shared.ts';
import { isMaestroNodeVisible } from './snapshot-policy.ts';
import { buildSnapshotNodeMap } from '@agent-device/contracts/snapshot';

export type MaestroTargetQuery = {
  selector: MaestroSelector;
  index?: number;
  childOf?: MaestroSelector;
  allowAtomicSelectorDispatch?: boolean;
};

export type MaestroTargetEvidence = {
  selector: MaestroSelector;
  childOf?: MaestroSelector;
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

type MaestroRankedCandidates = ReturnType<typeof rankMaestroCandidates>;

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
    : rankMaestroCandidates(snapshot, query.selector, platform, query.childOf);
  return resolveRankedMaestroTarget(
    query,
    platform,
    options.interactiveBounds === true,
    candidates,
    presentedNodes,
  );
}

function resolveRankedMaestroTarget(
  query: MaestroTargetQuery,
  platform: MaestroPlatform,
  interactiveBounds: boolean,
  candidates: MaestroRankedCandidates,
  presentedNodes: ReturnType<typeof createPresentedNodeLookup> | undefined,
): MaestroTargetResolution {
  if (!candidates.parentMatched) {
    return {
      ok: false,
      message: 'Maestro childOf parent did not match.',
      evidence: buildMaestroTargetEvidence(query, candidates.matches, [], undefined),
    };
  }
  const { matches, ranked: rankedMatches } = candidates;
  const sourceTarget = presentedNodes
    ? selectMaestroCandidate(rankedMatches, query.index)
    : selectMaestroSnapshotMatch(rankedMatches, query.index)?.node;
  const evidence = buildMaestroTargetEvidence(query, matches, rankedMatches, sourceTarget);
  if (!sourceTarget) {
    return failedTargetResolution(query, matches, rankedMatches, evidence);
  }
  return resolveSelectedMaestroTarget({
    query,
    platform,
    interactiveBounds,
    candidates,
    sourceTarget,
    presentedNodes,
    evidence,
  });
}

function resolveSelectedMaestroTarget(params: {
  query: MaestroTargetQuery;
  platform: MaestroPlatform;
  interactiveBounds: boolean;
  candidates: MaestroRankedCandidates;
  sourceTarget: SnapshotNode;
  presentedNodes: ReturnType<typeof createPresentedNodeLookup> | undefined;
  evidence: MaestroTargetEvidence;
}): MaestroTargetResolution {
  const { query, platform, candidates, sourceTarget, presentedNodes, evidence } = params;
  const presentedTarget = presentedNodes
    ? selectMaestroSnapshotMatch(presentedNodes.visibleForSource(sourceTarget), undefined)
    : null;
  const semanticTarget = selectMaestroSnapshotMatch([sourceTarget], 0);
  const rect = selectTargetRect(params.interactiveBounds, semanticTarget, presentedTarget);
  if (!rect) return failedTargetResolution(query, candidates.matches, candidates.ranked, evidence);
  return {
    ok: true,
    node: sourceTarget,
    rect,
    matches: candidates.ranked.length,
    dispatchCandidates: countAtomicDispatchCandidates({
      platform,
      query,
      presentationUsed: presentedNodes !== undefined,
      semanticTarget,
      rankedCandidates: candidates.ranked,
      presentedTarget,
    }),
    evidence,
  };
}

function selectTargetRect(
  interactiveBounds: boolean,
  semanticTarget: { rect: Rect } | null,
  presentedTarget: { rect: Rect } | null,
): Rect | undefined {
  return interactiveBounds
    ? (presentedTarget?.rect ?? semanticTarget?.rect)
    : (semanticTarget?.rect ?? presentedTarget?.rect);
}

function countAtomicDispatchCandidates(params: {
  platform: MaestroPlatform;
  query: MaestroTargetQuery;
  presentationUsed: boolean;
  semanticTarget: { node: SnapshotNode; rect: Rect } | null;
  rankedCandidates: SnapshotNode[];
  presentedTarget: { node: SnapshotNode; rect: Rect } | null;
}): number {
  if (
    params.platform !== 'ios' ||
    !params.query.allowAtomicSelectorDispatch ||
    params.query.childOf ||
    !params.presentationUsed
  ) {
    return 0;
  }
  return countInteractionDispatchCandidates(
    params.semanticTarget,
    params.rankedCandidates,
    params.presentedTarget,
  );
}

function createPresentedNodeLookup(presentation: MaestroInteractivePresentation): {
  isVisible: (node: SnapshotNode) => boolean;
  visibleForSource: (node: SnapshotNode) => SnapshotNode[];
} {
  const presentedByIndex = buildSnapshotNodeMap(presentation.snapshot.nodes);
  const forSource = (semanticNode: SnapshotNode): SnapshotNode[] => {
    return (presentation.presentedIndexesBySourceIndex.get(semanticNode.index) ?? []).flatMap(
      (presentedIndex) => {
        const node = presentedByIndex.get(presentedIndex);
        return node ? [node] : [];
      },
    );
  };
  const visibleForSource = (node: SnapshotNode): SnapshotNode[] =>
    forSource(node).filter((presentedNode) =>
      isMaestroNodeVisible(presentedNode, presentation.snapshot.nodes, 'ios'),
    );
  return { visibleForSource, isVisible: (node) => visibleForSource(node).length > 0 };
}

function rankPresentedMaestroCandidates(
  snapshot: SnapshotState,
  query: MaestroTargetQuery,
  presentedNodes: ReturnType<typeof createPresentedNodeLookup>,
) {
  const scoped = matchMaestroCandidates(snapshot, query.selector, query.childOf);
  const visible = scoped.matches.filter(presentedNodes.isVisible);
  return {
    ...scoped,
    visible,
    ranked: rankVisibleMaestroMatches(snapshot.nodes, visible, query.selector, 'ios'),
  };
}

function selectMaestroCandidate(
  matches: SnapshotNode[],
  index: number | undefined,
): SnapshotNode | undefined {
  return index === undefined ? matches[0] : matches[index];
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
  const index = query.index === undefined ? '' : ` index ${query.index}`;
  return { ok: false, message: `Maestro selector did not match${index}.`, evidence };
}

function countInteractionDispatchCandidates(
  target: { node: SnapshotNode; rect: Rect } | null,
  rankedCandidates: SnapshotNode[],
  presentedTarget: { node: SnapshotNode; rect: Rect } | null,
): number {
  if (rankedCandidates.length !== 1) return rankedCandidates.length;
  return target &&
    presentedTarget &&
    presentedTarget.node.hittable !== false &&
    haveSameTapPoint(presentedTarget.rect, target.rect)
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
    childOf: query.childOf,
    matched: matches.length > 0,
    visible: visibleMatches.length > 0,
    candidateCount: matches.length,
    ref: target?.ref,
  });
}
