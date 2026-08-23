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

const evidenceBySnapshotObject = new WeakMap<object, SnapshotClickabilityEvidence>();

export type SnapshotOcclusionContextEvidence = {
  /** Broad normalized presentation input retained when the public result is scoped. */
  nodes: readonly RawSnapshotNode[];
  /** Public input node index to its corresponding index in `nodes`. */
  sourceIndexByNodeIndex: ReadonlyMap<number, number>;
};

const occlusionContextBySnapshotObject = new WeakMap<object, SnapshotOcclusionContextEvidence>();

export function attachSnapshotClickabilityEvidence<T extends object>(
  owner: T,
  evidence: SnapshotClickabilityEvidence,
): T {
  evidenceBySnapshotObject.set(owner, evidence);
  return owner;
}

export function readSnapshotClickabilityEvidence(
  owner: object | null | undefined,
): SnapshotClickabilityEvidence | undefined {
  return owner ? evidenceBySnapshotObject.get(owner) : undefined;
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
  occlusionContextBySnapshotObject.set(owner, evidence);
  return owner;
}

export function readSnapshotOcclusionContextEvidence(
  owner: object | null | undefined,
): SnapshotOcclusionContextEvidence | undefined {
  return owner ? occlusionContextBySnapshotObject.get(owner) : undefined;
}

/** Copies every non-serializable capture fact needed before daemon publication. */
export function copySnapshotPrivateEvidence<T extends object>(
  source: object | null | undefined,
  target: T,
): T {
  const withClickability = copySnapshotClickabilityEvidence(source, target);
  const occlusionContext = readSnapshotOcclusionContextEvidence(source);
  return occlusionContext
    ? attachSnapshotOcclusionContextEvidence(withClickability, occlusionContext)
    : withClickability;
}
