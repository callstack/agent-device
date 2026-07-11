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
 * `details.reason` marker on the pre-action refusal thrown by dispatch's
 * post-resolution guard (`assertExpectedResolvedTarget`,
 * `src/commands/interaction/runtime/resolution.ts`), detected by the replay
 * step loop to convert the refusal into an identity-mismatch target-binding
 * divergence. Lives here (replay zone) so both the commands and daemon
 * layers can share it without a layering back-edge.
 */
export const REPLAY_TARGET_GUARD_MISMATCH_REASON = 'replay_target_guard_mismatch';
