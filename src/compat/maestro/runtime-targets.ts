import {
  attachRefs,
  type Rect,
  type SnapshotNode,
  type SnapshotState,
} from '../../kernel/snapshot.ts';
import { presentIosInteractiveSnapshot } from '../../daemon/snapshot-presentation/ios/index.ts';
import {
  buildSnapshotNodeByIndex,
  isDescendantOfSnapshotNode,
} from '../../snapshot/snapshot-processing.ts';
import type { MaestroSelector } from './program-ir.ts';
import { findMaestroTypedSelectorMatches } from './runtime-target-matching.ts';
import { filterVisibleMaestroMatches, type MaestroPlatform } from './runtime-target-policy.ts';
import { selectMaestroSnapshotMatch } from './runtime-target-ranking.ts';

export type MaestroTargetQuery = {
  selector: MaestroSelector;
  index?: number;
  childOf?: MaestroSelector;
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
): MaestroTargetResolution {
  let matches = findMaestroTypedSelectorMatches(snapshot, query.selector);
  if (query.childOf) {
    const parents = findMaestroTypedSelectorMatches(snapshot, query.childOf);
    if (parents.length === 0) {
      return {
        ok: false,
        message: 'Maestro childOf parent did not match.',
        evidence: buildMaestroTargetEvidence(query, matches, [], undefined),
      };
    }
    const nodeByIndex = buildSnapshotNodeByIndex(snapshot.nodes);
    matches = matches.filter((node) =>
      parents.some((parent) =>
        isDescendantOfSnapshotNode(snapshot.nodes, node, parent, nodeByIndex),
      ),
    );
  }

  const visible = filterVisibleMaestroMatches({ nodes: snapshot.nodes, matches, platform });
  const target = selectMaestroSnapshotMatch(visible.matches, query.index);
  const evidence = buildMaestroTargetEvidence(query, matches, visible.matches, target?.node);
  if (!target) {
    const index = query.index === undefined ? '' : ` index ${query.index}`;
    return {
      ok: false,
      message: visible.blockedByReactNativeOverlay
        ? 'React Native overlay is covering app content.'
        : matches.length > 0 && visible.matches.length === 0
          ? `Maestro selector matched ${matches.length} element(s), but none were visible.`
          : `Maestro selector did not match${index}.`,
      evidence,
    };
  }
  return {
    ok: true,
    node: target.node,
    rect: target.rect,
    matches: visible.matches.length,
    dispatchCandidates: countCanonicalDispatchCandidates(
      snapshot,
      query,
      platform,
      visible.matches,
    ),
    evidence,
  };
}

function countCanonicalDispatchCandidates(
  snapshot: SnapshotState,
  query: MaestroTargetQuery,
  platform: MaestroPlatform,
  visibleMatches: SnapshotNode[],
): number {
  if (platform !== 'ios' || query.childOf) return visibleMatches.length;
  const canonicalSnapshot = {
    ...snapshot,
    nodes: attachRefs(presentIosInteractiveSnapshot(snapshot.nodes)),
  };
  const canonicalMatches = findMaestroTypedSelectorMatches(canonicalSnapshot, query.selector);
  return filterVisibleMaestroMatches({
    nodes: canonicalSnapshot.nodes,
    matches: canonicalMatches,
    platform,
  }).matches.length;
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
