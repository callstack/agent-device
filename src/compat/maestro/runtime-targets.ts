import {
  attachRefs,
  type Rect,
  type SnapshotNode,
  type SnapshotState,
} from '../../kernel/snapshot.ts';
import {
  buildIosInteractiveSnapshotPresentation,
  type IosInteractiveSnapshotPresentation,
} from '../../daemon/snapshot-presentation/ios/index.ts';
import type { MaestroSelector } from './program-ir.ts';
import {
  findMaestroTypedSelectorMatches,
  scopeMaestroMatchesByAncestor,
} from './runtime-target-matching.ts';
import { filterVisibleMaestroMatches, type MaestroPlatform } from './runtime-target-policy.ts';
import {
  normalizeMaestroSnapshotMatches,
  selectMaestroSnapshotMatch,
} from './runtime-target-ranking.ts';
import { pointInsideRect } from '../../utils/rect-center.ts';

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
  options: { interactiveBounds?: boolean } = {},
): MaestroTargetResolution {
  let matches = findMaestroTypedSelectorMatches(snapshot, query.selector);
  if (query.childOf) {
    const scoped = scopeMaestroMatchesByAncestor(snapshot, matches, query.childOf);
    if (!scoped.parentMatched) {
      return {
        ok: false,
        message: 'Maestro childOf parent did not match.',
        evidence: buildMaestroTargetEvidence(query, matches, [], undefined),
      };
    }
    matches = scoped.matches;
  }

  const visible = filterVisibleMaestroMatches({ nodes: snapshot.nodes, matches, platform });
  const rankedMatches = normalizeMaestroSnapshotMatches(
    snapshot.nodes,
    visible.matches,
    query.selector,
    platform,
  );
  const target = selectMaestroSnapshotMatch(rankedMatches, query.index);
  const evidence = buildMaestroTargetEvidence(query, matches, rankedMatches, target?.node);
  if (!target) {
    return failedTargetResolution(query, matches, rankedMatches, visible, evidence);
  }
  const presentation =
    platform === 'ios' && (options.interactiveBounds || query.allowAtomicSelectorDispatch)
      ? buildIosInteractiveSnapshotPresentation(snapshot.nodes)
      : undefined;
  const rect =
    options.interactiveBounds === true
      ? (presentation?.sourceNodes.get(target.node.index)?.rect ?? target.rect)
      : target.rect;
  return {
    ok: true,
    node: target.node,
    rect,
    matches: rankedMatches.length,
    dispatchCandidates: countCanonicalDispatchCandidates(
      snapshot,
      query,
      platform,
      { ...target, rect },
      presentation,
    ),
    evidence,
  };
}

function failedTargetResolution(
  query: MaestroTargetQuery,
  matches: SnapshotNode[],
  rankedMatches: SnapshotNode[],
  visibility: { blockedByReactNativeOverlay: boolean },
  evidence: MaestroTargetEvidence,
): MaestroTargetResolution {
  if (visibility.blockedByReactNativeOverlay) {
    return { ok: false, message: 'React Native overlay is covering app content.', evidence };
  }
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

function countCanonicalDispatchCandidates(
  snapshot: SnapshotState,
  query: MaestroTargetQuery,
  platform: MaestroPlatform,
  target: { node: SnapshotNode; rect: Rect },
  presentation: IosInteractiveSnapshotPresentation | undefined,
): number {
  if (platform !== 'ios' || !query.allowAtomicSelectorDispatch || query.childOf) return 0;
  const canonicalSnapshot = {
    ...snapshot,
    nodes: attachRefs(
      (presentation ?? buildIosInteractiveSnapshotPresentation(snapshot.nodes)).nodes,
    ),
  };
  const canonicalMatches = findMaestroTypedSelectorMatches(canonicalSnapshot, query.selector);
  const canonicalVisibleMatches = filterVisibleMaestroMatches({
    nodes: canonicalSnapshot.nodes,
    matches: canonicalMatches,
    platform,
  }).matches;
  const canonicalRankedMatches = normalizeMaestroSnapshotMatches(
    canonicalSnapshot.nodes,
    canonicalVisibleMatches,
    query.selector,
    platform,
  );
  if (canonicalRankedMatches.length !== 1) return canonicalRankedMatches.length;
  const canonicalTarget = selectMaestroSnapshotMatch(canonicalRankedMatches, undefined);
  return canonicalTarget &&
    canonicalTarget.node.hittable !== false &&
    haveSameTapPoint(canonicalTarget.rect, target.rect)
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
  return {
    selector: query.selector,
    ...(query.childOf === undefined ? {} : { childOf: query.childOf }),
    matched: matches.length > 0,
    visible: visibleMatches.length > 0,
    candidateCount: matches.length,
    ...(target?.ref === undefined ? {} : { ref: target.ref }),
  };
}
