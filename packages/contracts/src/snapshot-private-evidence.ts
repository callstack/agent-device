import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

/**
 * Capture-local clickability facts for consumers that reproduce Maestro's private
 * TreeNode semantics. This is deliberately kept outside SnapshotNode: the fact
 * is retained by object identity, never serialized into the snapshot contract.
 */
export type SnapshotClickabilityEvidence =
  | {
      kind: 'exact';
      provider: 'android-helper';
      clickableByNodeIndex: ReadonlyMap<number, boolean | undefined>;
    }
  | {
      kind: 'divergence';
      provider: 'apple-xctest';
      reason: 'maestro-clickable-not-exposed-by-provider';
    };

export type AndroidSiblingOrderEvidence = { group: number; order: number };

export type SnapshotOcclusionContextEvidence = {
  /** Broad normalized presentation input retained when the public result is scoped. */
  nodes: readonly RawSnapshotNode[];
  /** Public input node index to its corresponding index in `nodes`. */
  sourceIndexByNodeIndex: ReadonlyMap<number, number>;
  /** Exact Android order plus an opaque original-sibling group (API 24+). */
  androidSiblingOrderByNodeIndex?: ReadonlyMap<number, AndroidSiblingOrderEvidence>;
};

type SnapshotPrivateEvidence = {
  clickability?: SnapshotClickabilityEvidence;
  occlusionContext?: SnapshotOcclusionContextEvidence;
};

const privateEvidenceBySnapshotObject = new WeakMap<object, SnapshotPrivateEvidence>();

function attachSnapshotPrivateEvidence<T extends object>(
  owner: T,
  evidence: SnapshotPrivateEvidence,
): T {
  privateEvidenceBySnapshotObject.set(owner, {
    ...privateEvidenceBySnapshotObject.get(owner),
    ...evidence,
  });
  return owner;
}

export function attachSnapshotClickabilityEvidence<T extends object>(
  owner: T,
  evidence: SnapshotClickabilityEvidence,
): T {
  return attachSnapshotPrivateEvidence(owner, { clickability: evidence });
}

export function readSnapshotClickabilityEvidence(
  owner: object | null | undefined,
): SnapshotClickabilityEvidence | undefined {
  return owner ? privateEvidenceBySnapshotObject.get(owner)?.clickability : undefined;
}

export function copySnapshotClickabilityEvidence<T extends object>(
  source: object | null | undefined,
  target: T,
): T {
  const evidence = readSnapshotClickabilityEvidence(source);
  return evidence ? attachSnapshotClickabilityEvidence(target, evidence) : target;
}

export function attachSnapshotOcclusionContextEvidence<T extends object>(
  owner: T,
  evidence: SnapshotOcclusionContextEvidence,
): T {
  return attachSnapshotPrivateEvidence(owner, { occlusionContext: evidence });
}

export function readSnapshotOcclusionContextEvidence(
  owner: object | null | undefined,
): SnapshotOcclusionContextEvidence | undefined {
  return owner ? privateEvidenceBySnapshotObject.get(owner)?.occlusionContext : undefined;
}
