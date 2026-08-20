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
