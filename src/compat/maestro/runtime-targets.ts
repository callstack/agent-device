import type { TouchReferenceFrame } from '../../daemon/touch-reference-frame.ts';
import type { Rect, SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import {
  buildSnapshotNodeByIndex,
  isDescendantOfSnapshotNode,
} from '../../snapshot/snapshot-processing.ts';
import type { MaestroSelector } from './program-ir.ts';
import { findMaestroTypedSelectorMatches } from './runtime-target-matching.ts';
import {
  extractMaestroVisibleTextQueryFromSelector,
  filterVisibleMaestroMatches,
  type MaestroPlatform,
  type MaestroPreferredContext,
} from './runtime-target-policy.ts';
import { selectMaestroSnapshotMatch } from './runtime-target-ranking.ts';

export type MaestroMatchResolutionOptions = {
  promoteTapTarget?: boolean;
  preferredContext?: MaestroPreferredContext;
  requireOnScreen?: boolean;
};

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
      evidence: MaestroTargetEvidence;
    }
  | { ok: false; message: string; evidence: MaestroTargetEvidence };

export type { MaestroPreferredContext } from './runtime-target-policy.ts';

export function resolveMaestroTargetFromSnapshot(
  snapshot: SnapshotState,
  query: MaestroTargetQuery,
  platform: MaestroPlatform,
  frame: TouchReferenceFrame | undefined,
  options: MaestroMatchResolutionOptions = {},
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
  const target = selectMaestroSnapshotMatch(
    snapshot.nodes,
    visible.matches,
    query.index,
    extractMaestroVisibleTextQueryFromSelector(query.selector),
    frame,
    options.requireOnScreen === true,
    options.promoteTapTarget,
    options.preferredContext,
  );
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
    evidence,
  };
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
