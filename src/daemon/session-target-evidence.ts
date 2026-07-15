/**
 * ADR 0012 decision 3: record-time computation of `.ad` target-binding
 * evidence (the `# agent-device:target-v1 {...}` annotation).
 *
 * `computeTargetEvidence` runs decision 3's "Record-time write" steps 1-5
 * against the tree the resolver already captured; it never captures, and
 * callers gate it on `session.recordSession`. Tree-agnostic spec pieces live
 * in `src/replay/target-identity.ts`, shared with the parser.
 *
 * The structural helpers below (identity/ancestry/sibling/scroll-region/
 * viewport-order) are exported so migration step 4's replay-time enforcement
 * (`session-replay-target-verification.ts`) computes every ordinal with the
 * SAME functions the writer used — "record and replay compute this ordinal
 * identically by definition" (decision 3, "Record-time write").
 */

import type { SnapshotNode } from '../kernel/snapshot.ts';
import { resolveRectCenter } from '../utils/rect-center.ts';
import { findNearestScrollableContainer } from './snapshot-presentation/tree.ts';
import {
  idMatchCountInTree,
  readNodeLocalIdentity,
  siblingOrdinal,
} from '../replay/target-identity-node.ts';
import {
  classifyTargetBindingMatch,
  matchesAncestryPrefix,
  matchesLocalIdentity,
  serializeTargetAnnotationV1,
  utf8ByteLength,
  TARGET_ANNOTATION_MAX_ANCESTRY,
  TARGET_ANNOTATION_MAX_PAYLOAD_BYTES,
  type LocalIdentity,
  type TargetAncestryEntry,
  type TargetAnnotationV1,
  type TargetScrollRegion,
  type TargetVerification,
} from '../replay/target-identity.ts';

/** ADR 0012 decision 3: the resolved winner and the tree it was resolved from. */
export type RecordedTargetCapture = {
  node: SnapshotNode;
  preActionNodes: SnapshotNode[];
};

export function computeTargetEvidence(
  capture: RecordedTargetCapture,
): TargetAnnotationV1 | undefined {
  const { node, preActionNodes: nodes } = capture;
  if (typeof node.index !== 'number') return undefined;
  const byIndex = buildIndexMap(nodes);
  const identity = demoteNonUniqueId(boundedLocalIdentity(node), nodes);
  const ancestryWalk = buildAncestryChain(node, byIndex, TARGET_ANNOTATION_MAX_ANCESTRY);
  const fullAncestry = ancestryWalk.chain;
  const sibling = computeSiblingOrdinal(nodes, node);
  const scrollRegion = computeScrollRegionKey(node, byIndex);
  const rect = boundedRect(node);

  // Decision 3's writer-parser invariant: reduce ancestry from the root side
  // until the payload fits, stopping once only `ancestry[0]` is retained
  // (floor 0 for a root node with no ancestors).
  const floor = fullAncestry.length > 0 ? 1 : 0;
  const buildCandidate = (ancestryLength: number) => {
    const ancestry = fullAncestry.slice(0, ancestryLength);
    const domain = computeDisambiguationDomain({
      nodes,
      byIndex,
      node,
      identity,
      ancestry,
      sibling,
      scrollRegion,
    });
    const candidate: TargetAnnotationV1 = {
      ...identity,
      ancestry,
      sibling,
      viewportOrder: domain.viewportOrder,
      ...(scrollRegion ? { scrollRegion } : {}),
      ...(rect ? { rect } : {}),
      verification: 'verified',
    };
    return { candidate, domain };
  };

  for (let ancestryLength = fullAncestry.length; ancestryLength >= floor; ancestryLength -= 1) {
    const { candidate, domain } = buildCandidate(ancestryLength);
    // Size against the longest verification value so the payload fits
    // whichever one the self-check returns.
    if (
      utf8ByteLength(serializeTargetAnnotationV1({ ...candidate, verification: 'unverifiable' })) <=
      TARGET_ANNOTATION_MAX_PAYLOAD_BYTES
    ) {
      // A broken parent walk is a capture anomaly: fail closed instead of
      // self-checking against structural signals that cannot be trusted.
      candidate.verification = ancestryWalk.broken
        ? 'unverifiable'
        : runRecordTimeSelfCheck({ node, domain });
      return candidate;
    }
    if (ancestryLength === floor) {
      // Decision 3's terminal fail-closed downgrade; rect is diagnostic-only
      // and is dropped before ever emitting an over-cap payload.
      candidate.verification = 'unverifiable';
      if (
        utf8ByteLength(serializeTargetAnnotationV1(candidate)) > TARGET_ANNOTATION_MAX_PAYLOAD_BYTES
      ) {
        delete candidate.rect;
      }
      return candidate;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Identity / ancestry / sibling / scroll region — decision 3's structural
// primitives, computed once per candidate node against the record-time tree.
// ---------------------------------------------------------------------------

export function buildIndexMap(nodes: readonly SnapshotNode[]): Map<number, SnapshotNode> {
  const map = new Map<number, SnapshotNode>();
  for (const node of nodes) map.set(node.index, node);
  return map;
}

/** The one identity reader (normalized AND field-capped, on every path): shared with dispatch's post-resolution guard. */
export const boundedLocalIdentity = readNodeLocalIdentity;

export type AncestryWalk = {
  chain: TargetAncestryEntry[];
  /**
   * Decision 3 capture anomaly: a `parentIndex` that resolves to no node, or
   * a parent cycle. A broken walk fails the annotation closed to
   * `unverifiable` — the structural signals cannot be trusted.
   */
  broken: boolean;
};

/** Decision 3 "Ancestry": nearest K ancestors, leaf→root, {role,label?}. */
export function buildAncestryChain(
  node: SnapshotNode,
  byIndex: Map<number, SnapshotNode>,
  limit: number,
): AncestryWalk {
  const chain: TargetAncestryEntry[] = [];
  const visited = new Set<number>([node.index]);
  let current = node;
  while (chain.length < limit) {
    if (typeof current.parentIndex !== 'number') return { chain, broken: false };
    const parent = byIndex.get(current.parentIndex);
    if (!parent || visited.has(parent.index)) return { chain, broken: true };
    visited.add(parent.index);
    const identity = boundedLocalIdentity(parent);
    chain.push({
      role: identity.role,
      ...(identity.label !== undefined ? { label: identity.label } : {}),
    });
    current = parent;
  }
  return { chain, broken: false };
}

/**
 * Decision 3 record-time write step 3: the winner's zero-based index among
 * its OWN parent's children, in document order. Root-level nodes (no parent)
 * are siblings of every other root-level node. Delegates to the shared
 * `siblingOrdinal` so the record-time writer, the classifier, and the
 * dispatch-side guard all compute this ordinal with one implementation.
 */
export function computeSiblingOrdinal(nodes: readonly SnapshotNode[], node: SnapshotNode): number {
  return siblingOrdinal(nodes, node);
}

/** Decision 3 record-time write step 4: nearest scrollable ancestor's local identity, or `undefined` for *none*. */
export function computeScrollRegionKey(
  node: SnapshotNode,
  byIndex: Map<number, SnapshotNode>,
): TargetScrollRegion | undefined {
  const container = findNearestScrollableContainer(node, byIndex);
  if (!container) return undefined;
  const identity = boundedLocalIdentity(container);
  return {
    role: identity.role,
    ...(identity.id !== undefined
      ? { id: identity.id }
      : identity.label !== undefined
        ? { label: identity.label }
        : {}),
  };
}

export function scrollRegionKeysEqual(
  a: TargetScrollRegion | undefined,
  b: TargetScrollRegion | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return matchesLocalIdentity(a, b);
}

function boundedRect(node: SnapshotNode): TargetAnnotationV1['rect'] {
  const rect = node.rect;
  if (!rect) return undefined;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

// ---------------------------------------------------------------------------
// Disambiguation domain: decision 3 record-time write step 2 (identity set)
// + step 4 (scroll-region partition + viewportOrder), and everything the
// step-5 self-check needs to classify the result.
// ---------------------------------------------------------------------------

type DisambiguationDomain = {
  identitySet: SnapshotNode[];
  siblingMatches: SnapshotNode[];
  regionMembers: SnapshotNode[] | undefined;
  orderedRegion: SnapshotNode[];
  viewportOrder: number;
};

/**
 * Decision 3 record-time write step 2 / replay-time verification's identity
 * set I: candidates sharing the recorded local identity with a matching
 * leaf-anchored ancestry prefix. Shared by the writer's self-check (over the
 * full record-time tree) and replay-time verification (over the recorded
 * selector/ref's matched-node domain) — "record and replay compute this
 * ordinal identically by definition" applies to this filter too.
 */
export function filterIdentitySet(
  candidates: readonly SnapshotNode[],
  byIndex: Map<number, SnapshotNode>,
  identity: LocalIdentity,
  ancestry: readonly TargetAncestryEntry[],
): SnapshotNode[] {
  return candidates.filter((candidate) => {
    if (!matchesLocalIdentity(boundedLocalIdentity(candidate), identity)) return false;
    const observed = buildAncestryChain(candidate, byIndex, Math.max(ancestry.length, 1));
    // A candidate with a broken parent walk cannot prove the prefix.
    return !observed.broken && matchesAncestryPrefix(observed.chain, ancestry);
  });
}

/**
 * ADR 0012 decision 3 amendment (#1269): an id is identity only when it
 * uniquely denotes the target in the record-time tree. `boundedLocalIdentity`
 * reads a node's id unconditionally, but a shared framework resource id
 * (Android's `android:id/title` matching every list row is the measured
 * case — #1269) is not selective: on replay the id-led identity set spans
 * every row, position drifts, and verification correctly refuses a
 * confident bind. `idMatchCountInTree` — the SAME predicate
 * `buildSelectorChainForNode` uses for the selector chain — counts nodes
 * sharing this canonical id across the whole tree; when more than one, fall
 * back to role+label, exactly the identity an unrecorded id already computes.
 * Both sites sharing one predicate is what keeps the tuple and the chain from
 * disagreeing (demoting one but not the other). The rule is capture-time
 * uniqueness, not an id-namespace heuristic: a reused RN `FlatList` `testID`
 * hits the same demotion on iOS.
 */
function demoteNonUniqueId(identity: LocalIdentity, nodes: readonly SnapshotNode[]): LocalIdentity {
  if (identity.id === undefined) return identity;
  if (idMatchCountInTree(nodes, identity.id) <= 1) return identity;
  const { role, label } = identity;
  return { role, ...(label !== undefined ? { label } : {}) };
}

function computeDisambiguationDomain(params: {
  nodes: readonly SnapshotNode[];
  byIndex: Map<number, SnapshotNode>;
  node: SnapshotNode;
  identity: LocalIdentity;
  ancestry: TargetAncestryEntry[];
  sibling: number;
  scrollRegion: TargetScrollRegion | undefined;
}): DisambiguationDomain {
  const { nodes, byIndex, node, identity, ancestry, sibling, scrollRegion } = params;

  const identitySet = filterIdentitySet(nodes, byIndex, identity, ancestry);

  const siblingMatches = identitySet.filter(
    (candidate) => computeSiblingOrdinal(nodes, candidate) === sibling,
  );

  const regionMembers =
    identitySet.length > 0
      ? identitySet.filter((candidate) =>
          scrollRegionKeysEqual(computeScrollRegionKey(candidate, byIndex), scrollRegion),
        )
      : undefined;

  const orderedRegion = regionMembers ? orderByViewportPosition(regionMembers) : [];
  const viewportOrder = Math.max(
    orderedRegion.findIndex((candidate) => candidate.index === node.index),
    0,
  );

  return { identitySet, siblingMatches, regionMembers, orderedRegion, viewportOrder };
}

/** Decision 3: rect center top-to-bottom then left-to-right; ties by document order; rect-less last, in document order. */
export function orderByViewportPosition(members: readonly SnapshotNode[]): SnapshotNode[] {
  return members
    .map((node, documentOrder) => ({ node, documentOrder, center: resolveRectCenter(node.rect) }))
    .sort((a, b) => {
      if (!a.center && !b.center) return a.documentOrder - b.documentOrder;
      if (!a.center) return 1;
      if (!b.center) return -1;
      if (a.center.y !== b.center.y) return a.center.y - b.center.y;
      if (a.center.x !== b.center.x) return a.center.x - b.center.x;
      return a.documentOrder - b.documentOrder;
    })
    .map((entry) => entry.node);
}

/**
 * Decision 3 record-time write step 5: run the shared replay-time
 * classification (`classifyTargetBindingMatch`) against the record-time tree
 * itself.
 */
function runRecordTimeSelfCheck(params: {
  node: SnapshotNode;
  domain: DisambiguationDomain;
}): TargetVerification {
  const { node, domain } = params;
  const winnerRef = node.ref;
  const identitySetRefs = domain.identitySet.map((n) => n.ref);
  const classification = classifyTargetBindingMatch({
    winnerRef,
    matchedRefs: identitySetRefs,
    identitySetRefs,
    siblingMatchRefs: domain.siblingMatches.map((n) => n.ref),
    regionMemberRefs: domain.regionMembers?.map((n) => n.ref),
    viewportCandidateRef: domain.orderedRegion[domain.viewportOrder]?.ref,
  });
  return classification.outcome;
}
