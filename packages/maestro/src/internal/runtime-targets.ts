import type { Rect, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import type { MaestroSelector } from './program-ir.ts';
import type { MaestroPlatform } from './runtime-target-policy.ts';
import { rankMaestroCandidates, selectMaestroSnapshotMatch } from './runtime-target-ranking.ts';
import { pointInsideRect, stripUndefined } from './shared.ts';
import { isDescendantOfSnapshotNode } from './snapshot-policy.ts';
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
    interaction?: {
      snapshot: SnapshotState;
      sourceIndexes: ReadonlyMap<number, number>;
    };
  } = {},
): MaestroTargetResolution {
  const candidates = rankMaestroCandidates(snapshot, query.selector, platform, query.childOf);
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
  const interactionCandidates = resolveInteractionCandidates(target.node, query, platform, options);
  const interactionTarget = interactionCandidates
    ? selectMaestroSnapshotMatch(interactionCandidates.mapped, undefined)
    : undefined;
  const rect =
    options.interactiveBounds === true ? (interactionTarget?.rect ?? target.rect) : target.rect;
  return {
    ok: true,
    node: target.node,
    rect,
    matches: rankedMatches.length,
    dispatchCandidates:
      platform === 'ios' && query.allowAtomicSelectorDispatch && !query.childOf
        ? countInteractionDispatchCandidates(target, interactionCandidates)
        : 0,
    evidence,
  };
}

function resolveInteractionCandidates(
  canonicalTarget: SnapshotNode,
  query: MaestroTargetQuery,
  platform: MaestroPlatform,
  options: {
    interaction?: {
      snapshot: SnapshotState;
      sourceIndexes: ReadonlyMap<number, number>;
    };
  },
): { all: SnapshotNode[]; mapped: SnapshotNode[] } | undefined {
  const interaction = options.interaction;
  if (!interaction) return undefined;
  const { snapshot, sourceIndexes } = interaction;
  const sourceIndex = sourceIndexes.get(canonicalTarget.index);
  if (sourceIndex === undefined) return undefined;
  const source = snapshot.nodes.find((node) => node.index === sourceIndex);
  if (!source) return undefined;
  const byIndex = buildSnapshotNodeMap(snapshot.nodes);
  const all = rankMaestroCandidates(snapshot, query.selector, platform, query.childOf).ranked;
  return {
    all,
    mapped: all.filter(
      (candidate) =>
        candidate.index === source.index ||
        isDescendantOfSnapshotNode(snapshot.nodes, candidate, source, byIndex),
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
  const index = query.index === undefined ? '' : ` index ${query.index}`;
  return { ok: false, message: `Maestro selector did not match${index}.`, evidence };
}

function countInteractionDispatchCandidates(
  target: { node: SnapshotNode; rect: Rect },
  interactionCandidates: { all: SnapshotNode[]; mapped: SnapshotNode[] } | undefined,
): number {
  if (!interactionCandidates) return 0;
  if (interactionCandidates.all.length !== 1) return interactionCandidates.all.length;
  const interactionTarget = selectMaestroSnapshotMatch(interactionCandidates.mapped, undefined);
  return interactionTarget &&
    interactionTarget.node.hittable !== false &&
    haveSameTapPoint(interactionTarget.rect, target.rect)
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
