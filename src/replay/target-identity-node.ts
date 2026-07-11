/**
 * ADR 0012 decision 3: the ONE snapshot-node local-identity reader —
 * normalized (NFC, label whitespace collapse, `normalizeType` role) AND
 * 256-byte field-capped, on every path. Shared by the record-time writer
 * (`src/daemon/session-target-evidence.ts`), replay-time verification
 * (`src/daemon/handlers/session-replay-target-verification.ts`), and the
 * dispatch-side post-resolution guard
 * (`src/commands/interaction/runtime/resolution.ts`), so all three compute
 * a node's identity with byte-identical semantics. Kept out of
 * `target-identity.ts` so that module stays tree-agnostic.
 */

import type { RawSnapshotNode } from '../kernel/snapshot.ts';
import { normalizeType } from '../snapshot/snapshot-processing.ts';
import {
  normalizeIdentifierField,
  normalizeLabelField,
  normalizeRoleField,
  truncateToUtf8Bytes,
  TARGET_ANNOTATION_MAX_FIELD_BYTES,
  type LocalIdentity,
} from './target-identity.ts';

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

/** Exact-equality comparison of two normalized local identities (all three fields). */
export function localIdentitiesEqual(a: LocalIdentity, b: LocalIdentity): boolean {
  return a.id === b.id && a.role === b.role && a.label === b.label;
}

/**
 * ADR 0012 decision 3: the STRUCTURAL denotation of a node within its capture
 * — the discriminators path 6 uses to isolate ONE member among several nodes
 * that share the same local identity.
 *
 * `documentOrder` is the node's pre-order tree-traversal index (decision 3's
 * "canonical total order of this contract"), which distinguishes ANY two
 * distinct nodes. `sibling` is its zero-based ordinal among its own parent's
 * children (decision 3 path 6.i). Both captures (the verifier's and
 * dispatch's) run the same snapshot pipeline, so for the same physical node
 * in the same screen these values agree; two distinct duplicates never share
 * a `documentOrder`.
 */
export type NodeStructuralDenotation = {
  documentOrder: number;
  sibling: number;
};

type StructuralNode = Pick<RawSnapshotNode, 'index' | 'parentIndex'>;

/** Zero-based ordinal among the node's own parent's children, in document (array) order. */
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

/**
 * The verified-member denotation carried on the pre-action guard
 * (`DaemonRequest.internal.replayTargetGuard`): its normalized local identity
 * PLUS the structural discriminator path 6 used to isolate it among same
 * local-identity duplicates. Comparing local identity alone would let a
 * different duplicate (identical id/role/label) pass the guard — the exact
 * verified-but-taps-different-node mis-binding step 4 exists to prevent.
 */
export type ReplayTargetGuardDenotation = {
  identity: LocalIdentity;
  structural: NodeStructuralDenotation;
};

/**
 * `details.reason` marker on the pre-action refusal thrown by dispatch's
 * post-resolution guard (`assertExpectedResolvedTarget`,
 * `src/commands/interaction/runtime/resolution.ts`), detected by the replay
 * step loop to convert the refusal into an identity-mismatch target-binding
 * divergence. Lives here (replay zone) so both the commands and daemon
 * layers can share it without a layering back-edge.
 */
export const REPLAY_TARGET_GUARD_MISMATCH_REASON = 'replay_target_guard_mismatch';
