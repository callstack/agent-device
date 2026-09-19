// Family modularity over the kept coupling edges. With `W` the total kept weight, `in_f` the
// weight with both ends in family `f`, `out_f` the weight with exactly one end in `f`, and
// `s_f = 2·in_f + out_f`:
//
//   intraShare = Σ_f in_f / W        expected = Σ_f (s_f / 2W)²        Q_f = in_f / W − (s_f / 2W)²
//
// so Σ_f Q_f = intraShare − expected (asserted in modularity.test.ts). `expected` is the
// intra-family share a random rewiring with the same per-family degree would produce, so the
// difference is how much more the families hold than their size alone predicts.

import type { CouplingEdge } from './affinity.ts';

export type FamilyOf = (file: string) => string;

export type FamilyModularityRow = {
  family: string;
  inWeight: number;
  outWeight: number;
  /** `2·in + out`, the family's share of edge ends. */
  s: number;
  Q: number;
  /** Other families this one shares at least one kept edge with, sorted. */
  partners: string[];
  /** `out / in`; `null` when the family keeps no weight inside itself. */
  outInFlow: number | null;
};

export type FamilyModularity = {
  totalWeight: number;
  intraShare: number;
  expected: number;
  modularity: number;
  crossFamilyEdges: number;
  perFamily: Map<string, FamilyModularityRow>;
};

export function familyModularity(
  edges: readonly CouplingEdge[],
  familyOf: FamilyOf,
  families: Iterable<string>,
): FamilyModularity {
  const rows = new Map<string, { inWeight: number; outWeight: number; partners: Set<string> }>();
  const rowFor = (family: string) => {
    const row = rows.get(family) ?? { inWeight: 0, outWeight: 0, partners: new Set<string>() };
    rows.set(family, row);
    return row;
  };
  for (const family of families) rowFor(family);

  let totalWeight = 0;
  let crossFamilyEdges = 0;
  for (const edge of edges) {
    totalWeight += edge.weight;
    const fa = familyOf(edge.a);
    const fb = familyOf(edge.b);
    if (fa === fb) {
      rowFor(fa).inWeight += edge.weight;
      continue;
    }
    crossFamilyEdges += 1;
    const rowA = rowFor(fa);
    const rowB = rowFor(fb);
    rowA.outWeight += edge.weight;
    rowB.outWeight += edge.weight;
    rowA.partners.add(fb);
    rowB.partners.add(fa);
  }

  const perFamily = new Map<string, FamilyModularityRow>();
  let intraShare = 0;
  let expected = 0;
  for (const [family, row] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    const s = 2 * row.inWeight + row.outWeight;
    const share = totalWeight > 0 ? row.inWeight / totalWeight : 0;
    const degree = totalWeight > 0 ? (s / (2 * totalWeight)) ** 2 : 0;
    intraShare += share;
    expected += degree;
    perFamily.set(family, {
      family,
      inWeight: row.inWeight,
      outWeight: row.outWeight,
      s,
      Q: share - degree,
      partners: [...row.partners].sort(),
      outInFlow: row.inWeight > 0 ? row.outWeight / row.inWeight : null,
    });
  }
  return {
    totalWeight,
    intraShare,
    expected,
    modularity: intraShare - expected,
    crossFamilyEdges,
    perFamily,
  };
}
