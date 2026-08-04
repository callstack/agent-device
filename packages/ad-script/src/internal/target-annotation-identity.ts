/**
 * ADR 0012 decision 3: the record/replay-shared local-identity + ancestry-
 * prefix matching over versioned `.ad` target-binding evidence, plus the
 * bounded diagnostic diffs built on top of it. Both the writer (over
 * `SnapshotNode`-derived values, `src/daemon/session-target-evidence.ts`) and
 * replay-time verification (`src/daemon/handlers/session-replay-target-classification.ts`,
 * `src/commands/interaction/runtime/selector-wait.ts`, and the shared
 * replay-zone tree helpers in `src/replay/`) share this verbatim so both
 * sides compute the SAME identity/ancestry match by construction (#1478 P5
 * review, "genuinely shared recording vocabulary" relocated to its owner).
 *
 * The classification core built on top of this (`classifyTargetBindingMatch`,
 * decision 3's replay-time verification paths 2-6) lives alongside this file
 * in `target-annotation-classification.ts` — both daemon-only consumers
 * (record-time self-check and replay-time classification) reach it from
 * here, not through `@agent-device/ad-replay`'s façade (#1555 review).
 */

import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import type {
  LocalIdentity,
  NodeStructuralDenotation,
  TargetAncestryEntry,
  TargetAnnotationV1,
} from '@agent-device/contracts/replay';
import {
  normalizeIdentifierField,
  normalizeLabelField,
  normalizeRoleField,
  truncateToUtf8Bytes,
  TARGET_ANNOTATION_MAX_FIELD_BYTES,
} from './target-annotation-serde.ts';

// ---------------------------------------------------------------------------
// Local identity + ancestry-prefix matching (decision 3 "Local identity" /
// "Ancestry"). Pure over the small structural shapes above — no tree
// dependency, so both the writer (over `SnapshotNode`-derived values) and a
// replay verifier can share it verbatim. The type vocabulary (`LocalIdentity`,
// `NodeStructuralDenotation`) lives in `@agent-device/contracts/replay` so the
// guard shapes there reference it nominally; this module re-exports it beside
// the readers that produce it.
// ---------------------------------------------------------------------------

export type { LocalIdentity, NodeStructuralDenotation };

type IdentityTreeNode = Pick<RawSnapshotNode, 'type' | 'identifier' | 'label'>;

/**
 * ADR 0012 decision 3: the ONE snapshot-node local-identity reader —
 * normalized (NFC, label whitespace collapse, `normalizeType` role) AND
 * 256-byte field-capped, on every path. Shared by the record-time writer
 * (`src/daemon/session-target-evidence.ts`), replay-time verification
 * (`src/daemon/handlers/session-replay-target-verification.ts`), and the
 * dispatch-side post-resolution guard
 * (`src/commands/interaction/runtime/resolution.ts`), so all three compute
 * a node's identity with byte-identical semantics.
 */
export function readNodeLocalIdentity(
  node: Pick<RawSnapshotNode, 'type' | 'identifier' | 'label'>,
): LocalIdentity {
  const role = normalizeRoleField(normalizeType(node.type ?? ''));
  const id = normalizeIdentifierField(node.identifier);
  const label = normalizeLabelField(node.label);
  return {
    ...(id !== undefined ? { id: truncateToUtf8Bytes(id, TARGET_ANNOTATION_MAX_FIELD_BYTES) } : {}),
    role: truncateToUtf8Bytes(role, TARGET_ANNOTATION_MAX_FIELD_BYTES),
    ...(label !== undefined
      ? { label: truncateToUtf8Bytes(label, TARGET_ANNOTATION_MAX_FIELD_BYTES) }
      : {}),
  };
}

/** Exact-equality comparison of two normalized local identities. */
export function localIdentitiesEqual(a: LocalIdentity, b: LocalIdentity): boolean {
  return a.id === b.id && a.role === b.role && a.label === b.label;
}

/**
 * ADR 0012 decision 3 amendment (#1269): how many nodes in `nodes` carry the
 * canonical identity `id`. THE single uniqueness predicate behind both
 * id-demotion sites — `computeTargetEvidence`'s `target-v1` identity tuple
 * and `buildSelectorChainForNode`'s selector chain. Sharing it is the
 * correctness guarantee: a non-unique id is dropped from BOTH or NEITHER,
 * never half-demoted (dropped from identity while still leading the chain, or
 * the reverse — the exact split #1269's fix exists to close).
 *
 * `id` is a canonical identity id (`readNodeLocalIdentity(node).id`: NFC +
 * 256-byte field cap, no trimming), and every candidate is measured through
 * the SAME reader, so the count is over exactly the identities the replay
 * verifier keys on. There is deliberately NO ancestry / parent-walk
 * exclusion: an id is non-selective the moment two nodes anywhere in the tree
 * carry it, independent of structural context or a broken parent linkage.
 */
export function idMatchCountInTree(nodes: readonly IdentityTreeNode[], id: string): number {
  let count = 0;
  for (const node of nodes) {
    if (readNodeLocalIdentity(node).id === id) count += 1;
  }
  return count;
}

/**
 * ADR 0012 decision 3 amendment (#1269): `identity` with its `id` demoted
 * whenever the id is non-unique in `nodes`, built on the SAME
 * `idMatchCountInTree` predicate `buildSelectorChainForNode`'s
 * `selectableId` keys off directly. `computeTargetEvidence` uses this
 * whole-identity form; extracted so a third call site (#1280's
 * press-retarget identity-empty check, `src/core/press-retarget.ts`)
 * shares it rather than re-deriving the rule a third way. A demoted id
 * falls back to role+label, the same shape an unrecorded id already
 * computes.
 */
export function demoteNonUniqueLocalIdentity(
  identity: LocalIdentity,
  nodes: readonly IdentityTreeNode[],
): LocalIdentity {
  if (identity.id === undefined) return identity;
  if (idMatchCountInTree(nodes, identity.id) <= 1) return identity;
  const { role, label } = identity;
  return { role, ...(label !== undefined ? { label } : {}) };
}

type StructuralNode = Pick<RawSnapshotNode, 'index' | 'parentIndex'>;

/** Zero-based ordinal among the node's own parent's children, in document order. */
export function siblingOrdinal(nodes: readonly StructuralNode[], node: StructuralNode): number {
  let ordinal = 0;
  for (const candidate of nodes) {
    if (candidate.parentIndex !== node.parentIndex) continue;
    if (candidate.index === node.index) return ordinal;
    ordinal += 1;
  }
  return 0;
}

export function readNodeStructuralDenotation(
  node: StructuralNode,
  nodes: readonly StructuralNode[],
): NodeStructuralDenotation {
  return { documentOrder: node.index, sibling: siblingOrdinal(nodes, node) };
}

/**
 * The guard passes only when BOTH structural discriminators agree — a
 * fail-closed comparison: two same-local-identity duplicates differ in
 * `documentOrder` (always) and usually `sibling`, so the guard refuses
 * whenever dispatch resolved a different member than verification isolated.
 */
export function structuralDenotationsEqual(
  a: NodeStructuralDenotation,
  b: NodeStructuralDenotation,
): boolean {
  return a.documentOrder === b.documentOrder && a.sibling === b.sibling;
}

/** The recorded annotation's identity tier as a bare `LocalIdentity` (drop-empty-keys form). */
export function annotationLocalIdentity(
  recorded: Pick<TargetAnnotationV1, 'id' | 'role' | 'label'>,
): LocalIdentity {
  return {
    ...(recorded.id !== undefined ? { id: recorded.id } : {}),
    role: recorded.role,
    ...(recorded.label !== undefined ? { label: recorded.label } : {}),
  };
}

/**
 * Decision 3 "Local identity": id match wins outright when the recording
 * carries one ("a recorded id never matches a node without that id"); with
 * no recorded id, role+label must both match (label absent on both sides
 * counts as equal; present on exactly one side is a mismatch).
 */
export function matchesLocalIdentity(candidate: LocalIdentity, recorded: LocalIdentity): boolean {
  if (recorded.id !== undefined) return candidate.id === recorded.id;
  return candidate.role === recorded.role && candidate.label === recorded.label;
}

/**
 * Decision 3 "Ancestry": leaf-anchored prefix match. `observed` must be at
 * least as long as `recorded`; each recorded entry's role must match exactly
 * and, when the recorded entry carries a label, so must the observed one (an
 * absent recorded label is unconstrained).
 */
export function matchesAncestryPrefix(
  observed: readonly TargetAncestryEntry[],
  recorded: readonly TargetAncestryEntry[],
): boolean {
  if (observed.length < recorded.length) return false;
  for (const [index, entry] of recorded.entries()) {
    const candidate = observed[index];
    if (!candidate) return false;
    if (candidate.role !== entry.role) return false;
    if (entry.label !== undefined && candidate.label !== entry.label) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Diagnostic diffs (decision 3): bounded, best-effort mismatch descriptions
// shared by the record-time classification core and replay-time verification
// (#1478 P5 stage C2a) — moved here verbatim from
// `src/daemon/handlers/session-replay-target-classification.ts` so both
// callers depend on one definition instead of two copies.
// ---------------------------------------------------------------------------

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

function describeAncestryEntry(entry: TargetAncestryEntry | undefined): string {
  return entry ? `${entry.role}${entry.label ? `/${entry.label}` : ''}` : '(missing)';
}

function ancestryEntryMismatches(
  expected: TargetAncestryEntry,
  actual: TargetAncestryEntry | undefined,
): boolean {
  if (!actual) return true;
  if (actual.role !== expected.role) return true;
  return expected.label !== undefined && actual.label !== expected.label;
}

/** Leaf-anchored prefix: the first divergence explains everything after it. */
export function firstAncestryMismatch(
  recordedAncestry: readonly TargetAncestryEntry[],
  observedAncestry: readonly TargetAncestryEntry[],
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
