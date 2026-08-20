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
  presentedIndexesBySourceIndex: ReadonlyMap<number, number[]>;
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
  const presentedNodes = options.presentation
    ? createPresentedNodeLookup(options.presentation)
    : undefined;
  const candidates = presentedNodes
    ? rankPresentedMaestroCandidates(snapshot, query, platform, presentedNodes)
    : rankMaestroCandidates(snapshot, query.selector, platform, query.childOf);
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
  const presentedTarget = presentedNodes
    ? selectMaestroSnapshotMatch(presentedNodes.forSource(target.node), undefined)
    : null;
  const rect =
    options.interactiveBounds === true ? (presentedTarget?.rect ?? target.rect) : target.rect;
  return {
    ok: true,
    node: target.node,
    rect,
    matches: rankedMatches.length,
    dispatchCandidates:
      platform === 'ios' && query.allowAtomicSelectorDispatch && !query.childOf && presentedNodes
        ? countInteractionDispatchCandidates(target, rankedMatches, presentedTarget)
        : 0,
    evidence,
  };
}

function createPresentedNodeLookup(presentation: MaestroInteractivePresentation): {
  isVisible: (node: SnapshotNode) => boolean;
  forSource: (node: SnapshotNode) => SnapshotNode[];
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
  return {
    forSource,
    isVisible: (node) =>
      forSource(node).some((presentedNode) =>
        isMaestroNodeVisible(presentedNode, presentation.snapshot.nodes, 'ios'),
      ),
  };
}

function rankPresentedMaestroCandidates(
  snapshot: SnapshotState,
  query: MaestroTargetQuery,
  platform: MaestroPlatform,
  presentedNodes: ReturnType<typeof createPresentedNodeLookup>,
) {
  const scoped = matchMaestroCandidates(snapshot, query.selector, query.childOf);
  const visible = scoped.matches.filter(presentedNodes.isVisible);
  return {
    ...scoped,
    visible,
    ranked: rankVisibleMaestroMatches(snapshot.nodes, visible, query.selector, platform),
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
  const index = query.index === undefined ? '' : ` index ${query.index}`;
  return { ok: false, message: `Maestro selector did not match${index}.`, evidence };
}

function countInteractionDispatchCandidates(
  target: { node: SnapshotNode; rect: Rect },
  rankedCandidates: SnapshotNode[],
  presentedTarget: { node: SnapshotNode; rect: Rect } | null,
): number {
  if (rankedCandidates.length !== 1) return rankedCandidates.length;
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
