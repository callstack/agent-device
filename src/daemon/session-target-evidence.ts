/**
 * ADR 0012 decision 3: record-time computation of `.ad` target-binding
 * evidence (the `# agent-device:target-v1 {...}` annotation).
 *
 * `computeTargetEvidence` implements decision 3's "Record-time write"
 * algorithm steps 1-5 against the SAME record-time tree the interaction
 * resolver just captured (`ResolvedInteractionTarget.node` +
 * `.preActionNodes`, see `src/commands/interaction/runtime/resolution.ts`).
 * It never captures anything itself — callers own gating this on whether the
 * session is actually being recorded (`session.recordSession`), since the
 * ancestry/identity-set scan is O(nodes) and pointless otherwise.
 *
 * This module lives under `src/daemon/` (not `src/replay/`) because it needs
 * `SnapshotNode`/`findNearestScrollableContainer` from the daemon's
 * snapshot-presentation layer, which sits above `replay` in the import DAG;
 * `replay` (below `daemon`) owns only the tree-agnostic spec pieces
 * (`src/replay/target-identity.ts`) that both the writer here and the parser
 * share.
 */

import type { SnapshotNode } from '../kernel/snapshot.ts';
import { resolveRectCenter } from '../utils/rect-center.ts';
import { normalizeType } from '../snapshot/snapshot-processing.ts';
import { findNearestScrollableContainer } from './snapshot-presentation/tree.ts';
import {
  classifyTargetBindingMatch,
  matchesAncestryPrefix,
  matchesLocalIdentity,
  normalizeIdentifierField,
  normalizeLabelField,
  normalizeRoleField,
  serializeTargetAnnotationV1,
  truncateToUtf8Bytes,
  utf8ByteLength,
  TARGET_ANNOTATION_MAX_ANCESTRY,
  TARGET_ANNOTATION_MAX_FIELD_BYTES,
  TARGET_ANNOTATION_MAX_PAYLOAD_BYTES,
  type LocalIdentity,
  type TargetAncestryEntry,
  type TargetAnnotationV1,
  type TargetScrollRegion,
  type TargetVerification,
} from '../replay/target-identity.ts';

export function computeTargetEvidence(params: {
  node: SnapshotNode;
  nodes: readonly SnapshotNode[];
}): TargetAnnotationV1 | undefined {
  const { node, nodes } = params;
  if (typeof node.index !== 'number') return undefined;
  const byIndex = buildIndexMap(nodes);
  const identity = boundedLocalIdentity(node);
  const fullAncestry = buildAncestryChain(node, byIndex, TARGET_ANNOTATION_MAX_ANCESTRY);
  const sibling = computeSiblingOrdinal(nodes, node);
  const scrollRegion = computeScrollRegionKey(node, byIndex);
  const rect = boundedRect(node);

  // Writer-parser invariant (decision 3): reduce ancestry from the root side
  // until the canonical serialization fits the 4 KiB payload cap. Every
  // string field is already bounded to 256 bytes by `boundedLocalIdentity`/
  // `buildAncestryChain`/`computeScrollRegionKey`, so this loop only ever
  // needs to shed ancestry entries. Decision 3 stops reducing once only
  // `ancestry[0]` (the parent) is retained — the floor is 1 when the winner
  // has any ancestor at all, else 0 (a root node has none to keep).
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
    // Size against the WORST-CASE verification value ("unverifiable" is 4
    // serialized bytes longer than "verified") so the payload provably fits
    // no matter what the self-check below returns — otherwise a payload
    // within 4 bytes of the cap could pass this check as "verified" and then
    // overflow once a fail-closed self-check downgraded it, violating the
    // writer-parser invariant exactly in the rare capture-anomaly case it
    // exists for.
    if (
      utf8ByteLength(serializeTargetAnnotationV1({ ...candidate, verification: 'unverifiable' })) <=
      TARGET_ANNOTATION_MAX_PAYLOAD_BYTES
    ) {
      candidate.verification = runRecordTimeSelfCheck({ node, domain });
      return candidate;
    }
    if (ancestryLength === floor) {
      // Decision 3's terminal fail-closed guarantee: a parent-only (or, for a
      // root node, ancestry-less) payload fits arithmetically once every
      // field is already capped at 256 bytes, so this branch is not expected
      // to run. If it somehow still doesn't fit, drop the diagnostic-only
      // rect (never compared) as one last, spec-consistent reduction rather
      // than emit a payload the parser would reject.
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

function buildIndexMap(nodes: readonly SnapshotNode[]): Map<number, SnapshotNode> {
  const map = new Map<number, SnapshotNode>();
  for (const node of nodes) map.set(node.index, node);
  return map;
}

function computeLocalIdentity(node: SnapshotNode): LocalIdentity {
  const role = normalizeRoleField(normalizeType(node.type ?? ''));
  const id = normalizeIdentifierField(node.identifier);
  const label = normalizeLabelField(node.label);
  return { ...(id !== undefined ? { id } : {}), role, ...(label !== undefined ? { label } : {}) };
}

function boundedLocalIdentity(node: SnapshotNode): LocalIdentity {
  const identity = computeLocalIdentity(node);
  return {
    ...(identity.id !== undefined
      ? { id: truncateToUtf8Bytes(identity.id, TARGET_ANNOTATION_MAX_FIELD_BYTES) }
      : {}),
    role: truncateToUtf8Bytes(identity.role, TARGET_ANNOTATION_MAX_FIELD_BYTES),
    ...(identity.label !== undefined
      ? { label: truncateToUtf8Bytes(identity.label, TARGET_ANNOTATION_MAX_FIELD_BYTES) }
      : {}),
  };
}

/** Decision 3 "Ancestry": nearest K ancestors, leaf→root, {role,label?}. */
function buildAncestryChain(
  node: SnapshotNode,
  byIndex: Map<number, SnapshotNode>,
  limit: number,
): TargetAncestryEntry[] {
  const chain: TargetAncestryEntry[] = [];
  const visited = new Set<number>();
  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  while (current && !visited.has(current.index) && chain.length < limit) {
    visited.add(current.index);
    const identity = boundedLocalIdentity(current);
    chain.push({
      role: identity.role,
      ...(identity.label !== undefined ? { label: identity.label } : {}),
    });
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
  return chain;
}

/**
 * Decision 3 record-time write step 3: the winner's zero-based index among
 * its OWN parent's children, in document order. Root-level nodes (no parent)
 * are siblings of every other root-level node.
 */
function computeSiblingOrdinal(nodes: readonly SnapshotNode[], node: SnapshotNode): number {
  const parentIndex = node.parentIndex;
  let ordinal = 0;
  for (const candidate of nodes) {
    if (candidate.parentIndex !== parentIndex) continue;
    if (candidate.index === node.index) return ordinal;
    ordinal += 1;
  }
  return 0;
}

/** Decision 3 record-time write step 4: nearest scrollable ancestor's local identity, or `undefined` for *none*. */
function computeScrollRegionKey(
  node: SnapshotNode,
  byIndex: Map<number, SnapshotNode>,
): TargetScrollRegion | undefined {
  // `findNearestScrollableContainer` is typed generically over
  // `RawSnapshotNode`; every value in `byIndex` is actually a `SnapshotNode`
  // (built from the same `nodes` array), so the cast back is safe.
  const container = findNearestScrollableContainer(node, byIndex) as SnapshotNode | null;
  if (!container) return undefined;
  const identity = boundedLocalIdentity(container);
  return {
    role: identity.role,
    ...(identity.id !== undefined ? { id: identity.id } : {}),
    ...(identity.label !== undefined ? { label: identity.label } : {}),
  };
}

function scrollRegionKeysEqual(
  a: TargetScrollRegion | undefined,
  b: TargetScrollRegion | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.role === b.role && a.id === b.id && a.label === b.label;
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

  // Step 2: all nodes sharing the winner's local identity with a matching
  // leaf-anchored ancestry prefix.
  const identitySet = nodes.filter((candidate) => {
    // Compare through the SAME 256-byte bounding the recorded `identity` and
    // ancestry entries already went through — otherwise a node whose own
    // id/label exceeds the field cap would spuriously fail to match ITSELF
    // (the recorded value is truncated; the raw candidate value is not),
    // corrupting both this self-check and, if the replay-time matcher ever
    // skipped the same bounding, a real node's identity check later.
    if (!matchesLocalIdentity(boundedLocalIdentity(candidate), identity)) return false;
    const observedAncestry = buildAncestryChain(candidate, byIndex, Math.max(ancestry.length, 1));
    return matchesAncestryPrefix(observedAncestry, ancestry);
  });

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
function orderByViewportPosition(members: readonly SnapshotNode[]): SnapshotNode[] {
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
 * Decision 3 record-time write step 5: run the replay-time classification
 * (decision 3's paths 2-6, shared via `classifyTargetBindingMatch`) against
 * the record-time tree itself. Paths 2/3 are unreachable here by
 * construction — the winner always matched itself and is always a member of
 * its own identity set — but are still fed through the shared classifier so
 * the exact same function runs at record and (in a future step) replay time.
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
