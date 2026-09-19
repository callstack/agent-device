// The two aggregate views over kept edges: files that carry the most coupling weight (hubs, with
// how many other families they reach) and the heaviest family pairs.

import type { CouplingEdge } from './affinity.ts';
import type { FamilyOf } from './modularity.ts';

export type CouplingHub = {
  id: string;
  family: string;
  /** Total kept weight on the file's edges. */
  weight: number;
  /** Weight on edges that leave the file's family. */
  outWeight: number;
  /** Distinct other families the file is coupled to. */
  outFamilies: number;
  /** Distinct files the file is coupled to. */
  partners: number;
};

export type FamilyPair = { a: string; b: string; weight: number; edges: number };

export function couplingHubs(
  edges: readonly CouplingEdge[],
  familyOf: FamilyOf,
  limit: number,
): CouplingHub[] {
  const stats = new Map<
    string,
    { weight: number; outWeight: number; families: Set<string>; partners: number }
  >();
  const statsFor = (id: string) => {
    const entry = stats.get(id) ?? { weight: 0, outWeight: 0, families: new Set(), partners: 0 };
    stats.set(id, entry);
    return entry;
  };
  for (const edge of edges) {
    const fa = familyOf(edge.a);
    const fb = familyOf(edge.b);
    for (const [id, own, other] of [
      [edge.a, fa, fb],
      [edge.b, fb, fa],
    ] as const) {
      const entry = statsFor(id);
      entry.weight += edge.weight;
      entry.partners += 1;
      if (own !== other) {
        entry.outWeight += edge.weight;
        entry.families.add(other);
      }
    }
  }
  return [...stats]
    .map(([id, entry]) => ({
      id,
      family: familyOf(id),
      weight: entry.weight,
      outWeight: entry.outWeight,
      outFamilies: entry.families.size,
      partners: entry.partners,
    }))
    .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))
    .slice(0, limit);
}

export function familyPairs(edges: readonly CouplingEdge[], familyOf: FamilyOf): FamilyPair[] {
  const pairs = new Map<string, FamilyPair>();
  for (const edge of edges) {
    const fa = familyOf(edge.a);
    const fb = familyOf(edge.b);
    if (fa === fb) continue;
    const [a, b] = fa < fb ? [fa, fb] : [fb, fa];
    const key = `${a}\n${b}`;
    const pair = pairs.get(key) ?? { a, b, weight: 0, edges: 0 };
    pair.weight += edge.weight;
    pair.edges += 1;
    pairs.set(key, pair);
  }
  return [...pairs.values()].sort(
    (left, right) =>
      right.weight - left.weight || `${left.a}/${left.b}`.localeCompare(`${right.a}/${right.b}`),
  );
}
