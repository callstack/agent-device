import type { Rect, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import type { MaestroSelector } from './program-ir.ts';
import type { MaestroPlatform } from './runtime-target-policy.ts';
import { rankMaestroCandidates, selectMaestroSnapshotMatch } from './runtime-target-ranking.ts';
import { pointInsideRect, stripUndefined } from './shared.ts';
import { isDescendantOfSnapshotNode, isMaestroNodeVisible } from './snapshot-policy.ts';
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
  sourceIndexes: ReadonlyMap<number, number>;
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
  const rawCandidates = rankMaestroCandidates(snapshot, query.selector, platform, query.childOf);
  const projection = options.presentation
    ? createPresentationProjection(snapshot, options.presentation)
    : undefined;
  const candidates = projection
    ? rankMaestroCandidates(snapshot, query.selector, platform, query.childOf, {
        isVisible: projection.isVisible,
      })
    : rawCandidates;
  if (!candidates.parentMatched) {
    return {
      ok: false,
      message: 'Maestro childOf parent did not match.',
      evidence: buildMaestroTargetEvidence(query, candidates.matches, [], undefined),
    };
  }
  const { matches, ranked: rankedMatches } = candidates;
  const target = selectMaestroSnapshotMatch(rankedMatches, query.index);
  const evidence = buildMaestroTargetEvidence(query, matches, rankedMatches, target?.node);
  if (!target) {
    return failedTargetResolution(query, matches, rankedMatches, evidence);
  }
  const presentedTarget = projection
    ? selectMaestroSnapshotMatch(projection.nodesFor(target.node), undefined)
    : undefined;
  const representativeTarget = projection
    ? selectMaestroSnapshotMatch(projection.representativesFor(target.node), undefined)
    : undefined;
  const rect =
    options.interactiveBounds === true ? (presentedTarget?.rect ?? target.rect) : target.rect;
  return {
    ok: true,
    node: target.node,
    rect,
    matches: rankedMatches.length,
    dispatchCandidates:
      platform === 'ios' && query.allowAtomicSelectorDispatch && !query.childOf
        ? countInteractionDispatchCandidates(target, rawCandidates.ranked, representativeTarget)
        : 0,
    evidence,
  };
}

function createPresentationProjection(
  semanticSnapshot: SnapshotState,
  presentation: MaestroInteractivePresentation,
): {
  isVisible: (node: SnapshotNode) => boolean;
  nodesFor: (node: SnapshotNode) => SnapshotNode[];
  representativesFor: (node: SnapshotNode) => SnapshotNode[];
} {
  const semanticByIndex = buildSnapshotNodeMap(semanticSnapshot.nodes);
  const directNodesBySourceIndex = new Map<number, SnapshotNode[]>();
  for (const presentedNode of presentation.snapshot.nodes) {
    const sourceIndex = presentation.sourceIndexes.get(presentedNode.index);
    if (sourceIndex === undefined) continue;
    const nodes = directNodesBySourceIndex.get(sourceIndex) ?? [];
    nodes.push(presentedNode);
    directNodesBySourceIndex.set(sourceIndex, nodes);
  }
  const nodesFor = (semanticNode: SnapshotNode): SnapshotNode[] => {
    return directNodesBySourceIndex.get(semanticNode.index) ?? [];
  };
  const representativesFor = (semanticNode: SnapshotNode): SnapshotNode[] => {
    const direct = nodesFor(semanticNode);
    if (direct.length > 0) return direct;
    const descendants: SnapshotNode[] = [];
    const equivalentAncestors: SnapshotNode[] = [];
    for (const presentedNode of presentation.snapshot.nodes) {
      const sourceIndex = presentation.sourceIndexes.get(presentedNode.index);
      const source = sourceIndex === undefined ? undefined : semanticByIndex.get(sourceIndex);
      if (!source) continue;
      if (
        isDescendantOfSnapshotNode(semanticSnapshot.nodes, source, semanticNode, semanticByIndex)
      ) {
        descendants.push(presentedNode);
      } else if (
        haveSharedSemanticIdentity(semanticNode, source) &&
        isDescendantOfSnapshotNode(semanticSnapshot.nodes, semanticNode, source, semanticByIndex)
      ) {
        equivalentAncestors.push(presentedNode);
      }
    }
    return descendants.length > 0 ? descendants : equivalentAncestors;
  };
  return {
    nodesFor,
    representativesFor,
    isVisible: (node) =>
      representativesFor(node).some((presentedNode) =>
        isMaestroNodeVisible(presentedNode, presentation.snapshot.nodes, 'ios'),
      ),
  };
}

function haveSharedSemanticIdentity(left: SnapshotNode, right: SnapshotNode): boolean {
  return [left.identifier, left.label, left.value].some(
    (value, index) =>
      Boolean(value?.trim()) && value === [right.identifier, right.label, right.value][index],
  );
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
  target: { node: SnapshotNode; rect: Rect },
  rawCandidates: SnapshotNode[],
  presentedTarget: { node: SnapshotNode; rect: Rect } | null | undefined,
): number {
  if (rawCandidates.length !== 1) return rawCandidates.length;
  return presentedTarget &&
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
