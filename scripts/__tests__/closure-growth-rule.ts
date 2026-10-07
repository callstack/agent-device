// The eager-closure NO-GROWTH rule and its split tolerance (#2469, ADR 0027).
//
// The gate in `eager-closure-budgets.ts` holds every entry that exists at the merge-base to
// "no more modules than the merge-base evaluated". The module count is a proxy for eager work,
// and the proxy disagrees with the repository's oversized-file rule at exactly one shape: a
// split of a hub module re-homes declarations into new files while evaluating the same total
// module-scope work, and every entry reaching the hub grows by the new files (#2423 had to
// defer its extraction; ADR 0027 measured the descriptor-root split at +11 per surface).
//
// The tolerance is three facts about the growth, all read from the closure graphs and the
// merge-base tree:
//
// 1. CONTAINMENT: the head closure still evaluates EVERY module the merge-base closure did
//    (renames canonicalized), so nothing was dropped or swapped -- the growth is purely
//    addition.
// 2. ADDED-MODULE NOVELTY: every module the head closure evaluates that the base closure did
//    not is absent from the merge-base tree at its rename-canonicalized path. A module the
//    merge-base tree already had, sitting outside the closure, becoming eager -- under its own
//    name or a new one -- is a NEW EDGE, not re-homed code; without this fact, weight deleted
//    elsewhere in the closure would fund it.
// 3. FLAT WEIGHT: the closure's total top-level statement count (`topLevelStatementCount`:
//    wiring excluded) did not grow. Smuggled eager work that ADDS a module-scope statement --
//    a call into a new heavy edge -- raises the weight and stays red.
//
// Any one or two alone are refutable: containment without novelty accepts pulling a
// pre-existing module in at flat weight; novelty without containment accepts dropping a
// merge-base module; weight without the other two accepts an unrelated shrinkage paying for a
// smuggled edge. The guarantee the triple states is exactly "newly evaluated modules are new
// files, and total statement weight is flat over a preserved closure" -- a split that REPLACES
// a statement with a more expensive one inside an existing file is invisible to any count, in
// modules or in statements, and is not what this tolerance was built to admit. It replaces
// neither the count comparison (which still fires first: growth must exist to be tolerated)
// nor the hard ADR-0019 checks (façade exactness, no platform implementation before binding),
// which stay count- and pattern-based and untouched.

/**
 * What one entry's no-growth verdict reads. Counts come from the closure graphs; weights are the
 * closures' total top-level statements (`topLevelStatementCount`: wiring excluded, so re-homing
 * code between modules is invisible to it); the subset facts say whether the head still evaluates
 * every module the merge-base did and whether every module it evaluates NEWLY is new to the tree.
 */
export type ClosureGrowthEvidence = {
  baseCount: number;
  headCount: number;
  baseWeight: number;
  headWeight: number;
  /** Head evaluates every module of the base closure (renames mapped through `renamedBaseToHead`). */
  preservedBaseClosure: boolean;
  /**
   * Every head-closure module the base closure did not evaluate is absent from the merge-base
   * tree at its rename-canonicalized path -- i.e. the added modules are split artifacts, not
   * pre-existing code newly made eager, under its own name or a renamed one.
   */
  addedModulesAreNew: boolean;
};

/**
 * The one comparison both the real-tree lane and the planted split tests run: counts straight off
 * the graphs, weights summed over each closure's own tree (a base module's weight read from the
 * base tree, its head counterpart from the head tree), and the split's two containment shapes
 * with renames canonicalized so a `git mv` inside a split stays the split it is.
 */
export function closureGrowthEvidence(params: {
  baseGraph: ReadonlyMap<string, string | null>;
  headGraph: ReadonlyMap<string, string | null>;
  baseWeights: ReadonlyMap<string, number>;
  headWeights: ReadonlyMap<string, number>;
  /** The committed merge-base tree, for the question every added module must answer: did you exist? */
  baseTree: { exists(file: string): boolean };
  renamedBaseToHead?: ReadonlyMap<string, string>;
}): ClosureGrowthEvidence {
  const { baseGraph, headGraph, baseWeights, headWeights, baseTree, renamedBaseToHead } = params;
  const sum = (files: Iterable<string>, weights: ReadonlyMap<string, number>) =>
    [...files].reduce((total, file) => total + (weights.get(file) ?? 0), 0);
  const baseOfRenamedHead = new Map<string, string>();
  for (const [baseFile, headFile] of renamedBaseToHead ?? []) {
    baseOfRenamedHead.set(headFile, baseFile);
  }
  return {
    baseCount: baseGraph.size,
    headCount: headGraph.size,
    baseWeight: sum(baseGraph.keys(), baseWeights),
    headWeight: sum(headGraph.keys(), headWeights),
    preservedBaseClosure: [...baseGraph.keys()].every((baseFile) =>
      headGraph.has(renamedBaseToHead?.get(baseFile) ?? baseFile),
    ),
    // A module the base closure evaluated (under its pre-rename path) is not an added one;
    // every other head module must be absent from the merge-base tree AT ITS CANONICALIZED
    // PATH. A rename head is checked at its BASE path, which the merge-base necessarily has --
    // so moving a closure-external module into the closure under a new name reads as what it
    // is: pre-existing code newly made eager, not a split artifact.
    addedModulesAreNew: [...headGraph.keys()].every((headFile) => {
      const baseFile = baseOfRenamedHead.get(headFile) ?? headFile;
      return baseGraph.has(baseFile) || !baseTree.exists(baseFile);
    }),
  };
}

/**
 * The no-growth verdict: `null` unless the head closure is larger than the merge-base one and the
 * growth fails one of the three split facts (containment, added-module novelty, flat weight).
 *
 * The closing sentence deliberately does not prescribe one fix. #2423's review found that a
 * generic "move it behind a dynamic import" sent five reviewers toward the wrong change: the
 * growth there was a small new module that belonged in a module every affected entry already
 * evaluated, not behind a lazy boundary. There are two common causes and two remedies, and which
 * applies is exactly what the added-module listing this verdict is always printed alongside
 * (`describeClosureGrowth`) is for.
 */
export function classifyGrowth(id: string, evidence: ClosureGrowthEvidence): string | null {
  const { baseCount, headCount, baseWeight, headWeight, preservedBaseClosure, addedModulesAreNew } =
    evidence;
  if (headCount <= baseCount) return null;
  if (preservedBaseClosure && addedModulesAreNew && headWeight <= baseWeight) return null;
  const reasons: string[] = [];
  if (!preservedBaseClosure) {
    reasons.push(
      'It stops evaluating a module the merge-base did, so it is not a split of existing code.',
    );
  }
  if (!addedModulesAreNew) {
    reasons.push(
      'It newly evaluates a module the merge-base tree already had, which no split of existing code explains; shrinkage elsewhere cannot fund a new eager edge.',
    );
  }
  if (headWeight > baseWeight) {
    reasons.push(
      preservedBaseClosure && addedModulesAreNew
        ? `It adds ${headCount - baseCount} module(s) and ${
            headWeight - baseWeight
          } top-level statement(s) of eager work on top of every module the merge-base already evaluated, which a pure split does not.`
        : `It adds ${headWeight - baseWeight} top-level statement(s) of eager work beyond the merge-base closure.`,
    );
  }
  return (
    `${id} evaluates ${headCount} modules on import; the merge-base evaluated ${baseCount}. ` +
    reasons.join(' ') +
    ' That means either a new static edge was added, or something that used to load on demand ' +
    'now loads eagerly. The fix is either to give the new code a home in a module the closure ' +
    'already evaluates, or to move the new edge behind a function-scoped `await import` -- see ' +
    'the added module(s) below for which one fits.'
  );
}
