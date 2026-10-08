# ADR 0027: Descriptor Root Size vs Eager-Closure Budget

## Status

Accepted (2026-10-07, #2469). The conflict below is resolved in favor of allowing
**byte-neutral (statement-neutral) re-homing**: the eager-closure budget's NO-GROWTH rule now
tolerates exactly the split shape — the head closure still evaluates every merge-base module,
every module it newly evaluates is new to the merge-base tree and to its deleted sources (a
`git mv` inside the base closure stays the same module through rename canonicalization, which
preserves modules already in the closure and is no pass for a pre-existing external module
moved in), and the closure's total module-scope statement count does not grow. The rule lives
in `scripts/__tests__/closure-growth-rule.ts`, planted in every failing direction by
`scripts/__tests__/closure-growth-rule.test.ts`. The hard ADR-0019 checks (façade exactness, no
platform implementation before binding) are untouched: the tolerance relaxes the module-count
proxy, never the loading property.

## The conflict

[ADR 0008](0008-command-descriptor-registry.md) makes `packages/command-registry/src/registry.ts`
the single **synchronous** descriptor root. `RAW_COMMAND_DESCRIPTORS` and every derived view — the
`Command` literal union, the catalog name sets, the `name`-keyed policy maps, batch policy — are
module-scope values, and consumers reach them through **value** imports.

`AGENTS.md` states that files past 1,000 lines are architecture debt and must be split before adding
behavior. The descriptor root is past that line.

`scripts/__tests__/eager-closure-budgets.ts` (the ADR 0019 loading-shape probe) measures each
published entry surface's eager **module count** against the committed merge-base and forbids any
increase. It has no approval path for growth by design; `APPROVED_OVER_CEILING` applies only to
first-introduced entries against `NEW_ENTRY_CEILINGS`.

Splitting a hub module necessarily adds static value edges beneath it, so every entry surface that
reaches it grows by the number of new modules. The two rules have no shared approval path: one says
the file must be divided, the other says the division must not be visible to any importer.

## Rules at a glance, resolved

- A hub split is allowed when it is statement-neutral: every merge-base module stays in every
  affected closure, every newly evaluated module is new to the merge-base tree and to its
  deleted sources (rename canonicalization preserves modules already in the base closure — it
  does not make a moved-in external module novel), and total module-scope statements do not
  grow. The gate enforces this; an unexplained count growth still fails with no approval path,
  as before.
- Do not add an approved-growth row, a baseline entry, or a suppression to pass the gate. That is
  the allowlist `AGENTS.md` forbids; the split tolerance is a rule, not a waiver — it decides from
  the two graphs, and nothing is hand-entered per split.
- Do not make registry construction asynchronous to dodge the walker. ADR 0008's synchronous root is
  load-bearing for compile-time totality.
- The split tolerance guarantees flat statement weight over a preserved closure; it does not
  license adding eager *edges* under a façade — the head must still evaluate every merge-base
  module, and the ADR-0019 checks stay hard.

## Measured

Splitting `RAW_COMMAND_DESCRIPTORS` into eleven family modules plus a shared trait module, byte-faithful
(80 descriptors, 79 byte-identical including comments), grew **every** entry surface reaching the root
by exactly **+11** modules. Route for all rows:
`… → catalog.ts → registry.ts → descriptor-traits.ts + descriptors/*.ts`.

| entry surface | merge-base | split |
| --- | --- | --- |
| `src/cli.ts` | 295 | 306 |
| `packages/session-journal/src/session-event-log.ts` | 92 | 103 |
| `packages/session-journal/src/session-event-action.ts` | 87 | 98 |
| `packages/session-journal/src/session-event-action-presentation.ts` | 83 | 94 |
| `packages/command-registry/src/batch.ts` | 80 | 91 |
| `packages/session-journal/src/session-event-request.ts` | 75 | 86 |
| `packages/command-registry/src/batch-policy.ts` | 74 | 85 |
| `packages/command-registry/src/planned-operations.ts` | 74 | 85 |
| `packages/command-registry/src/catalog.ts` | 73 | 84 |
| `packages/command-registry/src/owner-files.ts` | 73 | 84 |
| `packages/command-registry/src/registry.ts` | 72 | 83 |

Two facts make this unavoidable rather than incidental:

- Extracting only the shared trait module — the smallest possible decomposition — costs **+1** on the
  same eleven surfaces. There is no decomposition of this hub that passes.
- The walker erases type-only edges, so narrowing consumer imports cannot absorb the cost. These
  consumers need the derived values, not the types.

The cost is genuinely a *count*, not weight: the same bytes are evaluated either way. That is what
makes the conflict worth deciding rather than absorbing silently, because the gate's proxy and the
debt rule's proxy disagree at exactly this shape.

## Decision

May a byte-neutral re-homing of a hub module's contents into new modules raise the eager module
count of the entry surfaces that reach it? **Yes — exactly when it is a split**, decided by three
facts computed from the two closure graphs and the merge-base tree, not by an entered number:

1. **Containment:** the head closure evaluates every module the merge-base closure evaluated
   (renames canonicalized), so nothing was dropped or swapped.
2. **Added-module novelty:** every module the head closure evaluates that the base closure did
   not is absent from the merge-base tree at its rename-canonicalized path AND carries no code
   from a source deleted since the merge-base — matched when the added module shares **two or
   more identical normalized top-level statements** with one deleted source; a single shared
   statement is treated as coincidence, because short constants (a schema version, a default
   timeout) repeat across the repo and branding every reuse a move would poison new files).
   A module the tree already had, sitting outside the closure, becoming eager — under its own
   name, a renamed one, or a rewritten move that evades git's `-M` similarity pairing — is a
   new edge, not re-homed code; and without this fact, weight deleted elsewhere in the closure
   would fund it. Rename canonicalization preserves modules ALREADY IN the base closure; it is
   not a pass for an external module moved in, which fails the check at the base path the
   merge-base necessarily still has.
3. **Flat weight:** the closure's total top-level statement count — wiring lines excluded, so
   re-homing is invisible to it — does not exceed the merge-base closure's.

This is issue #2469's candidate 4 (structure ∧ weight), with the structure half implemented as
containment + novelty rather than candidate 2's importer-set shape. Any subset is refutable —
containment without novelty accepts pulling a pre-existing module in at flat weight, novelty
without containment accepts dropping a merge-base module, weight without the other two accepts
unrelated shrinkage paying for a smuggled edge — and the three together admit healthy extraction
while refusing any growth in the closure's module-scope statement weight. Statements were chosen
over bytes because formatting and comment churn move bytes while statements track the thing being
preserved: module-scope declarations and calls. The guarantee is exactly **newly evaluated
modules are new code — new paths that share at most one coincidental statement with any source
deleted since the merge-base (`movedFromDeletedSource`'s deliberate two-statement move-signal
threshold) — and total statement weight is flat over a preserved closure**, not
equality of eager behavior: a split that REPLACES an existing statement with a more expensive
top-level call inside an existing file moves no count and no weight, so it passes — nothing
count-based, in modules or statements, can see a like-for-like replacement. That residue is
bounded by what the tolerance cannot hide: every module the head newly evaluates is a path the
merge-base tree did not have AND is not a verbatim transplant — the move probe above brands any
added module sharing two or more statements with one deleted source as pre-existing code.
The probe is deliberately conservative and textual:
code REWRITTEN or reformulated during a move does not match it and would pass as novel, so what
is verified is "no verbatim transplant of a deleted source," not "no repurposed logic" (the
weight fact is what still refuses a transplant made heavier). What keeps the residue small is
everything around the probe: the hard ADR-0019 checks (façade exactness,
no platform implementation before binding) stay count- and pattern-based under it, and the
added-module listing every failure prints is what a reviewer reads. The planted tests in
`scripts/__tests__/closure-growth-rule.test.ts` pin every failing direction.

Maintenance cost of an ordinary extraction under this rule: zero configuration edits. No row,
baseline, or number is touched per split — the merge-base comparison recomputes everything. (The
candidate-3 approval-row design instead costs one hand-edited row per split plus its retirement.)

The `AGENTS.md` 1,000-line rule now has no hub exception to name: a statement-neutral split is
shippable, so an oversized hub is addressable debt rather than accepted state.

## Alternatives considered and refuted

- **Approved-growth row mirroring `APPROVED_OVER_CEILING` (issue, reason, owner):** refuted. It
  would be auditable, but it is an allowlist on the one invariant deliberately given no approval
  path, `AGENTS.md` forbids adding one to obtain a pass, and every split would owe a row plus its
  retirement — maintenance the chosen rule does not.
- **Structure alone (#2469 candidate 2):** refuted by the planted smuggle test — a "new" module can
  carry a new heavy edge, so containment proves nothing about eager work.
- **Containment + weight without added-module novelty (the rule's first draft on #3298):** refuted
  by the planted pre-existing-heavy test — deleting statements elsewhere in the closure funds a
  static edge to a merge-base module that sat outside it, which is real growth, not a split.
- **Novelty by merge-base tree path alone (the rule's second draft on #3298):** refuted by the
  planted rewritten-move test — a move that changes the path and churns formatting reports to
  git as delete + add, so an absent destination is not proof of new code. The deleted sources'
  statement texts close it down to a stated threshold: two identical normalized statements from
  one deleted source is the move signal, one is tolerated as coincidence (short constants repeat
  across the repo), and a transplant rewritten statement-by-statement stays outside a textual
  probe — what remains heuristic-free is the LIST of deleted sources (git's own delete listing,
  needing no similarity pairing to have been attempted), not the
  content match.
- **Weight alone (#2469 candidate 1):** refuted by the planted drop test — a swap can keep the
  statement total flat while quietly making the closure evaluate different modules.
- **Leave the array in place:** the status quo, not a resolution — it leaves the size debt unowned and
  the conflict undocumented.
- **Function-scoped `await import` per family:** passes the gate by making registry construction
  asynchronous, which removes the compile-time totality and literal-union guarantees ADR 0008 depends
  on. Trading a measured proxy cost for a lost correctness guarantee is the wrong direction.
- **Reduce descriptor verbosity instead of splitting the file:** legitimate and unexplored, but it
  changes the declaration vocabulary for all ~80 commands, which is a larger change than the split
  and needs its own decision.

## Recovery

A complete, byte-faithful split of the descriptor array exists on
`refactor/collocation-registry-family-split` (`40bf719a8b`, split commit `ad3aaa520e`) and is pushed.
With this decision accepted, that branch is now shippable: its +11 is a statement-neutral split of
exactly the tolerated shape, so it needs no gate change beyond this one.
