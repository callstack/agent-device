import type { ReplayDivergenceSuggestionBasis } from '../../replay/divergence.ts';

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
>(entries: Iterable<T>): T[] {
  const byNode = new Map<number, T>();
  for (const entry of entries) {
    const existing = byNode.get(entry.nodeIndex);
    if (!existing || basisRank(entry.basis) < basisRank(existing.basis)) {
      byNode.set(entry.nodeIndex, entry);
    }
  }
  return [...byNode.values()].sort(
    (left, right) =>
      basisRank(left.basis) - basisRank(right.basis) || left.nodeIndex - right.nodeIndex,
  );
}

function basisRank(basis: ReplayDivergenceSuggestionBasis): number {
  return BASIS_RANK[basis];
}
