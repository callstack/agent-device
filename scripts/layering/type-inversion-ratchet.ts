// R6: type-only spine inversions, per zone pair. R5 cannot see these (a type-only import is free
// at runtime), but "zone A is declared in terms of zone B" is still a boundary claim, and ranking
// type edges surfaced 61 of them. The survivors are argued in docs/dependency-graph-findings.md
// §0; the reference is the same count taken at the merge-base with origin/main, so a pair can
// only shrink and no change can bank headroom by recording a number above the tree.
//
// Catches: a type-only import against the ranked spine's declared order — a design-level
//   dependency (zone A is stated in terms of zone B) that R5 is blind to because it costs
//   nothing at runtime, so nothing else flags "the type shape leaks the wrong direction."
// Evidence: the R5-adjacent commits in check.ts's history introduced this ratchet; the 61-to-5
//   reduction and the surviving deliberate inversions are recorded in
//   docs/dependency-graph-findings.md.
// Cost: 118 LOC (61 rule + 57 test), plus the shared merge-base measurement in
//   ratchet-reference.ts.
// Kill criterion: none enforced today; retire only by maintainer decision that type-only spine
//   inversions no longer matter. Reaching zero remaining inversions does not retire it: at zero
//   the ratchet is what keeps the count from regrowing, and tsc never rejects a type-only edge.

import { typeInversionPair, type LayeringViolation, type ResolvedImportEdge } from './model.ts';

const RULE = 'R6 type-spine-inversion';

export function checkTypeInversions(
  edges: readonly ResolvedImportEdge[],
  reference: Readonly<Record<string, number>>,
): LayeringViolation[] {
  const seen = new Set<string>();
  const countsByPair = new Map<string, number>();
  const firstEdgeByPair = new Map<string, ResolvedImportEdge>();
  for (const edge of edges) {
    const pair = typeInversionPair(edge);
    if (!pair) continue;
    const identity = `${edge.file} -> ${edge.target}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    countsByPair.set(pair, (countsByPair.get(pair) ?? 0) + 1);
    if (!firstEdgeByPair.has(pair)) firstEdgeByPair.set(pair, edge);
  }

  const violations: LayeringViolation[] = [];
  for (const [pair, count] of [...countsByPair].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const allowed = reference[pair];
    const edge = firstEdgeByPair.get(pair)!;
    if (allowed === undefined) {
      violations.push({
        rule: RULE,
        file: edge.file,
        line: edge.line,
        message:
          `new type-only ${pair} inversion (${count} edge(s), e.g. ${edge.file} -> ${edge.target}); ` +
          `the merge-base has none. Declare the shared type below both zones.`,
      });
      continue;
    }
    if (count > allowed) {
      violations.push({
        rule: RULE,
        file: edge.file,
        line: edge.line,
        message:
          `type-only ${pair} inversions grew to ${count} (baseline ${allowed} at the merge-base). ` +
          `Move the shared type below both zones; the count may only shrink.`,
      });
    }
  }
  return violations;
}
