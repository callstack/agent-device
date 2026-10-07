// The eager-closure NO-GROWTH rule and its split tolerance (#2469, ADR 0027).
//
// The gate in `eager-closure-budgets.ts` holds every entry that exists at the merge-base to
// "no more modules than the merge-base evaluated". The module count is a proxy for eager work,
// and the proxy disagrees with the repository's oversized-file rule at exactly one shape: a
// split of a hub module re-homes declarations into new files while evaluating the same total
// module-scope work, and every entry reaching the hub grows by the new files (#2423 had to
// defer its extraction; ADR 0027 measured the descriptor-root split at +11 per surface).
//
// The tolerance is two facts about the growth, both read from the closure graphs:
//
// 1. CONTAINMENT: the head closure still evaluates EVERY module the merge-base closure did
//    (renames canonicalized), so nothing was dropped or swapped -- the growth is purely
//    addition.
// 2. FLAT WEIGHT: the closure's total top-level statement count (`topLevelStatementCount`:
//    wiring excluded) did not grow, so the added files carry re-homed declarations, not new
//    module-scope work. Any smuggled eager work -- a module-scope call into a new heavy edge --
//    adds statements and stays red.
//
// Each alone is insufficient: containment without weight accepts a split that smuggles eager
// work; weight without containment accepts dropping a merge-base module while adding a heavier
// one at the same statement count. Together they are the smallest rule that admits healthy
// extraction and refuses new eager edges, which is why they replace neither the count (the
// comparison still fires first: growth must exist to be tolerated) nor the hard ADR-0019 checks
// (façade exactness, no platform implementation before binding), which stay count- and
// pattern-based and untouched.

/**
 * What one entry's no-growth verdict reads. Counts come from the closure graphs; weights are the
 * closures' total top-level statements (`topLevelStatementCount`: wiring excluded, so re-homing
 * code between modules is invisible to it) and the subset fact says whether the head still
 * evaluates every module the merge-base did.
 */
export type ClosureGrowthEvidence = {
  baseCount: number;
  headCount: number;
  baseWeight: number;
  headWeight: number;
  /** Head evaluates every module of the base closure (renames mapped through `renamedBaseToHead`). */
  preservedBaseClosure: boolean;
};

/**
 * The one comparison both the real-tree lane and the planted split tests run: counts straight off
 * the graphs, weights summed over each closure's own tree (a base module's weight read from the
 * base tree, its head counterpart from the head tree), and the split's containment shape with
 * renames canonicalized so a `git mv` inside a split stays the split it is.
 */
export function closureGrowthEvidence(params: {
  baseGraph: ReadonlyMap<string, string | null>;
  headGraph: ReadonlyMap<string, string | null>;
  baseWeights: ReadonlyMap<string, number>;
  headWeights: ReadonlyMap<string, number>;
  renamedBaseToHead?: ReadonlyMap<string, string>;
}): ClosureGrowthEvidence {
  const { baseGraph, headGraph, baseWeights, headWeights, renamedBaseToHead } = params;
  const sum = (files: Iterable<string>, weights: ReadonlyMap<string, number>) =>
    [...files].reduce((total, file) => total + (weights.get(file) ?? 0), 0);
  return {
    baseCount: baseGraph.size,
    headCount: headGraph.size,
    baseWeight: sum(baseGraph.keys(), baseWeights),
    headWeight: sum(headGraph.keys(), headWeights),
    preservedBaseClosure: [...baseGraph.keys()].every((baseFile) =>
      headGraph.has(renamedBaseToHead?.get(baseFile) ?? baseFile),
    ),
  };
}

/**
 * The no-growth verdict: `null` unless the head closure is larger than the merge-base one and the
 * growth is not a tolerated pure split (containment plus flat weight, per the header).
 *
 * The closing sentence deliberately does not prescribe one fix. #2423's review found that a
 * generic "move it behind a dynamic import" sent five reviewers toward the wrong change: the
 * growth there was a small new module that belonged in a module every affected entry already
 * evaluated, not behind a lazy boundary. There are two common causes and two remedies, and which
 * applies is exactly what the added-module listing this verdict is always printed alongside
 * (`describeClosureGrowth`) is for.
 */
export function classifyGrowth(id: string, evidence: ClosureGrowthEvidence): string | null {
  const { baseCount, headCount, baseWeight, headWeight, preservedBaseClosure } = evidence;
  if (headCount <= baseCount) return null;
  if (preservedBaseClosure && headWeight <= baseWeight) return null;
  const weightNote = preservedBaseClosure
    ? ` It adds ${headCount - baseCount} module(s) and ${
        headWeight - baseWeight
      } top-level statement(s) of eager work on top of every module the merge-base already evaluated, which a pure split does not.`
    : ' It also stops evaluating a module the merge-base did, so it is not a split of existing code.';
  return (
    `${id} evaluates ${headCount} modules on import; the merge-base evaluated ${baseCount}.` +
    weightNote +
    ' That means either a new static edge was added, or something that used to load on demand ' +
    'now loads eagerly. The fix is either to give the new code a home in a module the closure ' +
    'already evaluates, or to move the new edge behind a function-scoped `await import` -- see ' +
    'the added module(s) below for which one fits.'
  );
}
