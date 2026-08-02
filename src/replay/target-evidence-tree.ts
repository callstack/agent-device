/**
 * ADR 0012 decision 3: the tree-structural evidence primitives shared by the
 * record-time writer (`src/daemon/session-target-evidence.ts`), replay-time
 * verification (`src/daemon/handlers/session-replay-target-classification.ts`),
 * and the command-resolution landmark check `wait` runs inside its polling
 * loop (#1349, `src/commands/interaction/runtime/selector-read.ts`). They are
 * pure functions over `SnapshotNode` trees; keeping them in the shared
 * `replay/` zone lets the commands runtime consume them without importing the
 * daemon.
 */

import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { readNodeLocalIdentity } from './target-identity-node.ts';
import {
  matchesAncestryPrefix,
  matchesLocalIdentity,
  type LocalIdentity,
} from './target-identity.ts';
import type { TargetAncestryEntry } from '@agent-device/contracts/replay';

export function buildIndexMap(nodes: readonly SnapshotNode[]): Map<number, SnapshotNode> {
  const map = new Map<number, SnapshotNode>();
  for (const node of nodes) map.set(node.index, node);
  return map;
}

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
    const identity = readNodeLocalIdentity(parent);
    chain.push({
      role: identity.role,
      ...(identity.label !== undefined ? { label: identity.label } : {}),
    });
    current = parent;
  }
  return { chain, broken: false };
}

/**
 * Decision 3 record-time write step 2 / replay-time verification's identity
 * set I: candidates sharing the recorded local identity with a matching
 * leaf-anchored ancestry prefix. Shared by the writer's self-check (over the
 * full record-time tree), replay-time verification (over the recorded
 * selector/ref's matched-node domain), and wait's in-loop landmark check —
 * "record and replay compute this ordinal identically by definition" applies
 * to this filter too.
 */
export function filterIdentitySet(
  candidates: readonly SnapshotNode[],
  byIndex: Map<number, SnapshotNode>,
  identity: LocalIdentity,
  ancestry: readonly TargetAncestryEntry[],
): SnapshotNode[] {
  return candidates.filter((candidate) => {
    if (!matchesLocalIdentity(readNodeLocalIdentity(candidate), identity)) return false;
    const observed = buildAncestryChain(candidate, byIndex, Math.max(ancestry.length, 1));
    // A candidate with a broken parent walk cannot prove the prefix.
    return !observed.broken && matchesAncestryPrefix(observed.chain, ancestry);
  });
}
