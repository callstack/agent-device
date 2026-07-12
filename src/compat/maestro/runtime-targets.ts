import type { MaestroSelector } from './program-ir.ts';
import type { Rect, SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import { parseSelectorChain } from '../../selectors/index.ts';
import type { TouchReferenceFrame } from '../../daemon/touch-reference-frame.ts';
import type { DaemonRequest } from '../../daemon/types.ts';
import {
  extractMaestroVisibleTextQueryFromSelector,
  filterVisibleMaestroMatches,
  type MaestroPlatform,
  type MaestroPreferredContext,
} from './runtime-target-policy.ts';
import {
  findMaestroFuzzyTextMatches,
  findMaestroSelectorMatches,
  findMaestroTypedSelectorMatches,
} from './runtime-target-matching.ts';
import { selectMaestroSnapshotMatch } from './runtime-target-ranking.ts';
import { buildSnapshotNodeByIndex, isDescendantOfSnapshotNode } from '../../snapshot/snapshot-processing.ts';

export type MaestroTapOnOptions = {
  childOf?: string;
  index?: number;
};

export type MaestroSnapshotTarget = {
  node: SnapshotNode;
  rect: Rect;
  frame?: TouchReferenceFrame;
};

export type MaestroMatchResolutionOptions = {
  promoteTapTarget?: boolean;
  preferredContext?: MaestroPreferredContext;
  requireOnScreen?: boolean;
  allowLeadingCompositeLabelMatch?: boolean;
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
  | {
      ok: false;
      message: string;
      evidence: MaestroTargetEvidence;
    };

export type { MaestroPreferredContext } from './runtime-target-policy.ts';

export function resolveMaestroNodeFromSnapshot(
  snapshot: SnapshotState,
  selector: string,
  options: MaestroTapOnOptions,
  platform: MaestroPlatform,
  frame: TouchReferenceFrame | undefined,
  resolutionOptions: MaestroMatchResolutionOptions = {},
): { ok: true; node: SnapshotNode; rect: Rect } | { ok: false; message: string } {
  let matches = findLegacyMaestroSelectorMatches(snapshot, selector, platform);
  if (options.childOf) {
    const parents = findLegacyMaestroSelectorMatches(snapshot, options.childOf, platform);
    if (parents.length === 0) {
      return { ok: false, message: `Maestro childOf parent did not match: ${options.childOf}` };
    }
    const nodeByIndex = buildSnapshotNodeByIndex(snapshot.nodes);
    matches = matches.filter((node) =>
      parents.some((parent) =>
        isDescendantOfSnapshotNode(snapshot.nodes, node, parent, nodeByIndex),
      ),
    );
  }
  const visibleMatchesResult = filterVisibleMaestroMatches({
    nodes: snapshot.nodes,
    matches,
    platform,
  });

  const target = selectMaestroSnapshotMatch(
    snapshot.nodes,
    visibleMatchesResult.matches,
    options.index,
    extractMaestroVisibleTextQuery(selector),
    frame,
    resolutionOptions.requireOnScreen === true,
    resolutionOptions.promoteTapTarget,
    resolutionOptions.preferredContext,
  );
  if (!target) {
    const index = options.index ?? 0;
    return {
      ok: false,
      message: visibleMatchesResult.blockedByReactNativeOverlay
        ? `React Native overlay is covering app content: ${selector}`
        : matches.length > 0 && visibleMatchesResult.matches.length === 0
          ? `Maestro selector matched ${matches.length} element(s), but none were visible: ${selector}`
          : `Maestro selector did not match index ${index}: ${selector}`,
    };
  }
  return { ok: true, node: target.node, rect: target.rect };
}

export function resolveMaestroTargetFromSnapshot(
  snapshot: SnapshotState,
  query: MaestroTargetQuery,
  platform: MaestroPlatform,
  frame: TouchReferenceFrame | undefined,
  resolutionOptions: MaestroMatchResolutionOptions = {},
): MaestroTargetResolution {
  const matchOptions = {
    allowLeadingCompositeLabelMatch: resolutionOptions.allowLeadingCompositeLabelMatch,
  };
  let matches = findMaestroTypedSelectorMatches(snapshot, query.selector, matchOptions);
  if (query.childOf) {
    const parents = findMaestroTypedSelectorMatches(
      snapshot,
      query.childOf,
      matchOptions,
    );
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

  const visibleMatchesResult = filterVisibleMaestroMatches({
    nodes: snapshot.nodes,
    matches,
    platform,
  });
  const target = selectMaestroSnapshotMatch(
    snapshot.nodes,
    visibleMatchesResult.matches,
    query.index,
    extractMaestroVisibleTextQueryFromSelector(query.selector),
    frame,
    resolutionOptions.requireOnScreen === true,
    resolutionOptions.promoteTapTarget,
    resolutionOptions.preferredContext,
  );
  const evidence = buildMaestroTargetEvidence(
    query,
    matches,
    visibleMatchesResult.matches,
    target?.node,
  );
  if (!target) {
    const index = query.index === undefined ? '' : ` index ${query.index}`;
    return {
      ok: false,
      message: visibleMatchesResult.blockedByReactNativeOverlay
        ? 'React Native overlay is covering app content.'
        : matches.length > 0 && visibleMatchesResult.matches.length === 0
          ? `Maestro selector matched ${matches.length} element(s), but none were visible.`
          : `Maestro selector did not match${index}.`,
      evidence,
    };
  }
  return {
    ok: true,
    node: target.node,
    rect: target.rect,
    matches: visibleMatchesResult.matches.length,
    evidence,
  };
}

export function resolveMaestroFuzzyTextNodeFromSnapshot(
  snapshot: SnapshotState,
  query: string,
  platform: MaestroPlatform,
  frame: TouchReferenceFrame | undefined,
  resolutionOptions: MaestroMatchResolutionOptions = {},
): { ok: true; node: SnapshotNode; rect: Rect } | { ok: false; message: string } {
  const matches = findMaestroFuzzyTextMatches(snapshot, query);
  const visibleMatchesResult = filterVisibleMaestroMatches({
    nodes: snapshot.nodes,
    matches,
    platform,
  });
  const target = selectMaestroSnapshotMatch(
    snapshot.nodes,
    visibleMatchesResult.matches,
    undefined,
    query,
    frame,
    resolutionOptions.requireOnScreen === true,
    resolutionOptions.promoteTapTarget,
    resolutionOptions.preferredContext,
  );
  if (!target) {
    return { ok: false, message: `Maestro fuzzy text did not match: ${query}` };
  }
  return { ok: true, node: target.node, rect: target.rect };
}

export function resolveVisibleMaestroNodeFromSnapshot(
  snapshot: SnapshotState,
  selector: string,
  platform: MaestroPlatform,
  frame: TouchReferenceFrame | undefined,
): { ok: true; node: SnapshotNode; rect: Rect; matches: number } | { ok: false; message: string } {
  const matches = findLegacyMaestroSelectorMatches(snapshot, selector, platform, {
    allowLeadingCompositeLabelMatch: false,
  });
  const visibleMatchesResult = filterVisibleMaestroMatches({
    nodes: snapshot.nodes,
    matches,
    platform,
  });
  const target = selectMaestroSnapshotMatch(
    snapshot.nodes,
    visibleMatchesResult.matches,
    undefined,
    extractMaestroVisibleTextQuery(selector),
    frame,
    true,
  );
  if (!target) {
    return {
      ok: false,
      message: visibleMatchesResult.blockedByReactNativeOverlay
        ? `React Native overlay is covering app content: ${selector}`
        : matches.length > 0
          ? `Maestro selector matched ${matches.length} element(s), but none were visible: ${selector}`
          : `Maestro selector did not match: ${selector}`,
    };
  }
  return {
    ok: true,
    node: target.node,
    rect: target.rect,
    matches: visibleMatchesResult.matches.length,
  };
}

export function hasMaestroSelectorMatchInSnapshot(
  snapshot: SnapshotState,
  selector: string,
  platform: MaestroPlatform,
): boolean {
  return findLegacyMaestroSelectorMatches(snapshot, selector, platform, {
    allowLeadingCompositeLabelMatch: false,
  }).length > 0;
}

export function readMaestroSelectorPlatform(flags: DaemonRequest['flags']): MaestroPlatform {
  return flags?.platform === 'android' ? 'android' : 'ios';
}

export function extractMaestroVisibleTextQuery(selectorExpression: string): string | null {
  const chain = parseSelectorChain(selectorExpression);
  const terms = chain.selectors.flatMap((selector) => selector.terms);
  if (terms.length === 0) return null;
  // Mixed selectors may encode more than a visible-text lookup, so they keep
  // the exact selector path instead of fuzzy text fallback.
  if (!terms.some((term) => term.key === 'label' || term.key === 'text')) return null;
  if (!terms.every((term) => ['label', 'text', 'id'].includes(term.key))) return null;
  const values = terms.map((term) => (typeof term.value === 'string' ? term.value : ''));
  const first = values[0];
  if (!first || !values.every((value) => value === first)) return null;
  return first;
}

function findLegacyMaestroSelectorMatches(
  snapshot: SnapshotState,
  selectorExpression: string,
  platform: MaestroPlatform,
  options: Parameters<typeof findMaestroSelectorMatches>[3] = {},
): SnapshotNode[] {
  const chain = parseSelectorChain(selectorExpression);
  return findMaestroSelectorMatches(snapshot, chain.selectors, platform, options);
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
