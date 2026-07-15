/**
 * ADR 0012 migration step 4: replay-time target-binding verification
 * enforcement.
 *
 * For every replay/test step whose action carries `target-v1` evidence
 * (`action.targetEvidence`, parsed by `src/replay/script.ts` /
 * `src/replay/target-identity.ts`), this resolves the SAME recorded
 * selector/ref the action's own dispatch would use against a fresh
 * pre-action snapshot, classifies the match via decision 3's six-path
 * algorithm (`classifyTargetBindingMatch`), and — on any non-verified
 * outcome — builds a complete `REPLAY_DIVERGENCE` response carrying the
 * target-binding `kind` (`selector-miss` / `identity-mismatch` /
 * `identity-unverifiable`) instead of ever sending the device action. Only
 * the verified outcome (decision 3 paths 4 and 6-verified) lets the caller
 * proceed to the normal `invokeReplayAction` dispatch.
 *
 * Unannotated actions (`targetEvidence` absent — old scripts, or a command
 * this migration step doesn't cover) return `{ verified: true }`
 * immediately: pass-through, unchanged behavior.
 *
 * This module is wired ONLY from the replay/test step loop
 * (`session-replay-runtime.ts`) — never from live interactive command
 * dispatch — so `resolveInteractionTarget`'s live click/press/fill/
 * longpress/get path is completely unaffected.
 *
 * `classifyReplayTarget` below is the pure tree-classification core (no
 * capture, no session, no wire shaping) so migration step 4's validation
 * bullet — all six verification paths, sibling recurrence under different
 * parents, region-partitioned viewportOrder domains, a recorded region gone,
 * out-of-range ordinals, document-order determinism — is testable directly
 * against constructed `SnapshotNode` trees.
 */

import type { Platform, PublicPlatform } from '../../kernel/device.ts';
import { findNodeByRef, normalizeRef, type SnapshotNode } from '../../kernel/snapshot.ts';
import { findNodeByLabel } from '../../snapshot/snapshot-processing.ts';
import { matchesSelector } from '../../selectors/match.ts';
import {
  listSelectorChainMatches,
  resolveSelectorChain,
  tryParseSelectorChain,
} from '../../selectors/index.ts';
import {
  buildIndexMap,
  boundedLocalIdentity,
  buildAncestryChain,
  computeSiblingOrdinal,
  computeScrollRegionKey,
  scrollRegionKeysEqual,
  orderByViewportPosition,
  filterIdentitySet,
} from '../session-target-evidence.ts';
import {
  classifyTargetBindingMatch,
  type LocalIdentity,
  type TargetAnnotationV1,
} from '../../replay/target-identity.ts';
import type { ReplayDivergenceTargetBindingKind } from '../../replay/divergence.ts';

// ---------------------------------------------------------------------------
// Pure classification core — no capture, no session, no wire shaping.
// ---------------------------------------------------------------------------

export type ReplayTargetVerified = {
  verified: true;
  /** The verified member — the resolution winner on every verified path. */
  winnerNode: SnapshotNode;
  /** Decision 3's `matchCount` domain size (nodes matching the recorded selector/ref). */
  matchCount: number;
};

export type ReplayTargetDivergent = {
  verified: false;
  kind: ReplayDivergenceTargetBindingKind;
  matchCount: number | undefined;
  observedNode: SnapshotNode | undefined;
  candidateNodes: SnapshotNode[];
  mismatches: string[];
  causeCode: string;
  causeMessage: string;
};

export type ReplayTargetClassification = ReplayTargetVerified | ReplayTargetDivergent;

/**
 * Decision 3's replay-time verification, over an already-captured tree: not
 * itself path 1 (recorded-`unverifiable`) — callers check that before ever
 * building a tree domain, since path 1 fires before any resolution.
 */
export function classifyReplayTarget(params: {
  recorded: TargetAnnotationV1;
  token: string;
  nodes: SnapshotNode[];
  platform: Platform | PublicPlatform;
  refLabel: string | undefined;
  requireRect: boolean;
  allowDisambiguation: boolean;
}): ReplayTargetClassification {
  const { recorded, token, nodes, platform, refLabel, requireRect, allowDisambiguation } = params;

  const matching = resolveTargetMatches({
    token,
    nodes,
    platform,
    refLabel,
    requireRect,
    allowDisambiguation,
  });

  const byIndex = buildIndexMap(nodes);
  const identity = identityAsLocalIdentity(recorded);
  const identitySet = filterIdentitySet(
    matching.matchedNodes,
    byIndex,
    identity,
    recorded.ancestry,
  );
  const siblingMatches = identitySet.filter(
    (candidate) => computeSiblingOrdinal(nodes, candidate) === recorded.sibling,
  );
  const regionMembers = identitySet.filter((candidate) =>
    scrollRegionKeysEqual(computeScrollRegionKey(candidate, byIndex), recorded.scrollRegion),
  );
  const orderedRegion = orderByViewportPosition(regionMembers);
  const viewportCandidateRef = orderedRegion[recorded.viewportOrder]?.ref;

  const classification = classifyTargetBindingMatch({
    winnerRef: matching.winnerRef,
    matchedRefs: matching.matchedNodes.map((node) => node.ref),
    identitySetRefs: identitySet.map((node) => node.ref),
    siblingMatchRefs: siblingMatches.map((node) => node.ref),
    regionMemberRefs: regionMembers.map((node) => node.ref),
    viewportCandidateRef,
  });

  const winnerNode = matching.matchedNodes.find((node) => node.ref === matching.winnerRef);
  if (classification.outcome === 'verified' && winnerNode) {
    // A verified winner is always an identity-set member ⊆ matched set, so
    // winnerNode is defined here; the fall-through below is fail-closed.
    return { verified: true, winnerNode, matchCount: matching.matchedNodes.length };
  }
  if (classification.outcome === 'verified') {
    return {
      verified: false,
      kind: 'identity-unverifiable',
      matchCount: matching.matchedNodes.length,
      observedNode: undefined,
      candidateNodes: identitySet.slice(0, 5),
      mismatches: [],
      causeCode: 'IDENTITY_UNVERIFIABLE',
      causeMessage:
        'Verification isolated a member that is not part of the matched-node domain (capture anomaly).',
    };
  }

  const mapped = mapVerificationFailure({
    classification,
    matchCount: matching.matchedNodes.length,
    winnerNode,
    identitySet,
    byIndex,
    recorded,
  });
  return { verified: false, ...mapped };
}

type TargetMatchResolution = { matchedNodes: SnapshotNode[]; winnerRef: string };

/**
 * Resolves the recorded target's matched-node domain and its resolution
 * winner, using the SAME lookup/matching a real dispatch would: ref lookup
 * (with the recorded `refLabel` fallback, `resolveRefInteractionTarget`'s
 * pattern) or `resolveSelectorChain` with the SAME per-command
 * rect/disambiguation config `resolveSuggestionMatchingConfig` already gives
 * heal's suggestion re-resolution.
 */
function resolveTargetMatches(params: {
  token: string;
  nodes: SnapshotNode[];
  platform: Platform | PublicPlatform;
  refLabel: string | undefined;
  requireRect: boolean;
  allowDisambiguation: boolean;
}): TargetMatchResolution {
  const { token, nodes, platform, refLabel, requireRect, allowDisambiguation } = params;
  return token.startsWith('@')
    ? resolveRefTargetMatches(nodes, token, refLabel, requireRect)
    : resolveSelectorTargetMatches(nodes, token, platform, requireRect, allowDisambiguation);
}

function resolveRefTargetMatches(
  nodes: SnapshotNode[],
  token: string,
  refLabel: string | undefined,
  requireRect: boolean,
): TargetMatchResolution {
  const usable = (node: SnapshotNode | null): node is SnapshotNode =>
    node !== null && (!requireRect || Boolean(node.rect));
  const ref = normalizeRef(token);
  const byRef = ref ? findNodeByRef(nodes, ref) : null;
  if (usable(byRef)) return { matchedNodes: [byRef], winnerRef: byRef.ref };
  const byLabel = refLabel ? findNodeByLabel(nodes, refLabel) : null;
  return usable(byLabel)
    ? { matchedNodes: [byLabel], winnerRef: byLabel.ref }
    : { matchedNodes: [], winnerRef: '' };
}

function resolveSelectorTargetMatches(
  nodes: SnapshotNode[],
  token: string,
  platform: Platform | PublicPlatform,
  requireRect: boolean,
  allowDisambiguation: boolean,
): TargetMatchResolution {
  const chain = tryParseSelectorChain(token);
  if (!chain) return { matchedNodes: [], winnerRef: '' };
  const resolved = resolveSelectorChain(nodes, chain, {
    platform,
    requireRect,
    requireUnique: true,
    disambiguateAmbiguous: allowDisambiguation,
  });
  if (!resolved) {
    // No alternative produced a dispatch winner (for example, ambiguity with
    // disambiguation disabled). Keep the established diagnostic domain so
    // classification can report that ambiguity, but do not invent a winner.
    const matchList = listSelectorChainMatches(nodes, chain, { platform, requireRect });
    return { matchedNodes: matchList?.matchedNodes ?? [], winnerRef: '' };
  }
  // `resolved.selector` is the selected chain alternative. The verification
  // domain must use that same alternative, not the first one with any match:
  // an earlier ambiguous/tied alternative can be skipped in favor of a later
  // resolvable alternative.
  const matchedNodes = nodes.filter((node) => {
    if (requireRect && !node.rect) return false;
    return matchesSelector(node, resolved.selector, platform);
  });
  return { matchedNodes, winnerRef: resolved.node.ref };
}

function identityAsLocalIdentity(recorded: TargetAnnotationV1): LocalIdentity {
  return {
    ...(recorded.id !== undefined ? { id: recorded.id } : {}),
    role: recorded.role,
    ...(recorded.label !== undefined ? { label: recorded.label } : {}),
  };
}

type MappedVerificationFailure = Omit<ReplayTargetDivergent, 'verified'>;

/** Decision 3 paths 2/3/5/6 (excluding verified), mapped onto a wire divergence kind. */
function mapVerificationFailure(params: {
  classification: Exclude<ReturnType<typeof classifyTargetBindingMatch>, { outcome: 'verified' }>;
  matchCount: number;
  winnerNode: SnapshotNode | undefined;
  identitySet: SnapshotNode[];
  byIndex: Map<number, SnapshotNode>;
  recorded: TargetAnnotationV1;
}): MappedVerificationFailure {
  const { classification, matchCount, winnerNode, identitySet, byIndex, recorded } = params;
  switch (classification.reason) {
    case 'selector-miss':
      return {
        kind: 'selector-miss',
        matchCount: 0,
        observedNode: undefined,
        candidateNodes: [],
        mismatches: [],
        causeCode: 'SELECTOR_MISS',
        causeMessage: 'The recorded target no longer matches any current element.',
      };
    case 'identity-set-empty':
      return {
        kind: 'identity-mismatch',
        matchCount,
        observedNode: winnerNode,
        candidateNodes: [],
        mismatches: winnerNode ? computeIdentityMismatches(recorded, winnerNode, byIndex) : [],
        causeCode: 'IDENTITY_MISMATCH',
        causeMessage:
          'The recorded selector/ref still matches, but nothing in the current tree carries the recorded identity.',
      };
    case 'unique-but-wrong':
      return {
        kind: 'identity-mismatch',
        matchCount,
        observedNode: winnerNode,
        candidateNodes: [],
        mismatches: winnerNode ? computeIdentityMismatches(recorded, winnerNode, byIndex) : [],
        causeCode: 'IDENTITY_MISMATCH',
        causeMessage:
          'Exactly one current element carries the recorded identity, but the resolved target is a different element.',
      };
    case 'signal-isolated-wrong':
      return {
        kind: 'identity-mismatch',
        matchCount,
        observedNode: winnerNode,
        candidateNodes: [],
        mismatches: winnerNode ? computeIdentityMismatches(recorded, winnerNode, byIndex) : [],
        causeCode: 'IDENTITY_MISMATCH',
        causeMessage:
          'A disambiguation signal (sibling or viewport position) isolated a different element than the resolved target.',
      };
    case 'no-signal-isolation':
      return {
        kind: 'identity-unverifiable',
        matchCount,
        observedNode: winnerNode,
        candidateNodes: identitySet.slice(0, 5),
        mismatches: [],
        causeCode: 'IDENTITY_UNVERIFIABLE',
        causeMessage: `${identitySet.length} current elements carry the recorded identity and neither disambiguation signal isolated one.`,
      };
  }
}

/**
 * Bounded, best-effort diagnostic diff between the recorded identity/
 * ancestry and the actual resolution winner's own — first differing field
 * only per component, leaf-anchored-prefix semantics for ancestry (the first
 * divergence explains everything after it).
 */
function computeIdentityMismatches(
  recorded: TargetAnnotationV1,
  observedNode: SnapshotNode,
  byIndex: Map<number, SnapshotNode>,
): string[] {
  const observed = boundedLocalIdentity(observedNode);
  const observedAncestry = buildAncestryChain(
    observedNode,
    byIndex,
    Math.max(recorded.ancestry.length, 1),
  ).chain;
  return [
    ...identityFieldMismatches(recorded, observed),
    ...firstAncestryMismatch(recorded.ancestry, observedAncestry),
  ].slice(0, 5);
}

export function identityFieldMismatches(
  recorded: TargetAnnotationV1,
  observed: LocalIdentity,
): string[] {
  const mismatches: string[] = [];
  if (recorded.id !== observed.id) {
    mismatches.push(`id: recorded=${recorded.id ?? '(none)'} observed=${observed.id ?? '(none)'}`);
  }
  if (recorded.role !== observed.role) {
    mismatches.push(`role: recorded=${recorded.role} observed=${observed.role}`);
  }
  if (recorded.label !== observed.label) {
    mismatches.push(
      `label: recorded=${recorded.label ?? '(none)'} observed=${observed.label ?? '(none)'}`,
    );
  }
  return mismatches;
}

function describeAncestryEntry(entry: { role: string; label?: string } | undefined): string {
  return entry ? `${entry.role}${entry.label ? `/${entry.label}` : ''}` : '(missing)';
}

function ancestryEntryMismatches(
  expected: { role: string; label?: string },
  actual: { role: string; label?: string } | undefined,
): boolean {
  if (!actual) return true;
  if (actual.role !== expected.role) return true;
  return expected.label !== undefined && actual.label !== expected.label;
}

/** Leaf-anchored prefix: the first divergence explains everything after it. */
function firstAncestryMismatch(
  recordedAncestry: readonly { role: string; label?: string }[],
  observedAncestry: readonly { role: string; label?: string }[],
): string[] {
  for (const [index, expected] of recordedAncestry.entries()) {
    const actual = observedAncestry[index];
    if (!ancestryEntryMismatches(expected, actual)) continue;
    return [
      `ancestry[${index}]: recorded=${describeAncestryEntry(expected)} observed=${describeAncestryEntry(actual)}`,
    ];
  }
  return [];
}
