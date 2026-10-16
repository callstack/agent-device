import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { buildIndexMap } from '@agent-device/ad-script';
import {
  computeScrollRegionKey,
  scrollRegionKeysEqual,
} from '@agent-device/selectors/target-evidence';
import type { ReplayDivergenceSuggestionBasis } from '@agent-device/contracts/divergence';

const BASIS_RANK: Record<ReplayDivergenceSuggestionBasis, number> = {
  id: 0,
  'role-label': 1,
  label: 2,
  other: 3,
};

export function rankAndDedupeReplaySuggestions<
  T extends {
    readonly nodeIndex: number;
    readonly basis: ReplayDivergenceSuggestionBasis;
  },
>(
  entries: Iterable<T>,
  context: {
    nodes: readonly SnapshotNode[];
    targetEvidence: TargetAnnotationV1 | undefined;
  },
): T[] {
  const byNode = new Map<number, T>();
  for (const entry of entries) {
    const existing = byNode.get(entry.nodeIndex);
    if (!existing || basisRank(entry.basis) < basisRank(existing.basis)) {
      byNode.set(entry.nodeIndex, entry);
    }
  }
  const sameRegion = new Set<number>();
  if (context.targetEvidence?.verification === 'verified') {
    const byIndex = buildIndexMap(context.nodes);
    for (const nodeIndex of byNode.keys()) {
      const node = byIndex.get(nodeIndex);
      if (
        node &&
        scrollRegionKeysEqual(
          computeScrollRegionKey(node, byIndex),
          context.targetEvidence.scrollRegion,
        )
      )
        sameRegion.add(nodeIndex);
    }
  }
  return [...byNode.values()].sort(
    (left, right) =>
      basisRank(left.basis) - basisRank(right.basis) ||
      Number(sameRegion.has(right.nodeIndex)) - Number(sameRegion.has(left.nodeIndex)) ||
      left.nodeIndex - right.nodeIndex,
  );
}

function basisRank(basis: ReplayDivergenceSuggestionBasis): number {
  return BASIS_RANK[basis];
}
