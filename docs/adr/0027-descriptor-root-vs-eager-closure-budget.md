# ADR 0027: Descriptor Root Size vs Eager-Closure Budget

## Status

Accepted (2026-10-07, #2469).
The decision permits **byte-neutral (statement-neutral) re-homing** under the exact split conditions below.
The eager-closure NO-GROWTH rule tolerates this structure:

- The head closure still evaluates every merge-base module.
- Every newly evaluated module is new to the merge-base tree and its deleted sources.
- Total module-scope statement count does not grow.

Rename canonicalization preserves a `git mv` of a module already inside the base closure.
It does not exempt a pre-existing external module moved into the closure.
`scripts/__tests__/closure-growth-rule.ts` owns the rule.
`scripts/__tests__/closure-growth-rule.test.ts` plants violations in every failing direction.
The hard ADR-0019 checks remain unchanged: façade exactness and no platform implementation before binding.
The tolerance relaxes the module-count proxy, never the loading property.

## Rules at a glance, resolved

- A hub split is permitted when it is statement-neutral: it has containment, added-module novelty, and flat module-scope statement count.
  The gate enforces all three.
  Unexplained count growth still fails without an approval path.
- Do not add an approved-growth row, baseline entry, or suppression to pass the gate.
  That would be the allowlist prohibited by `AGENTS.md`.
  The split tolerance is a rule, not a waiver.
  It decides from the two graphs, and nobody enters a value by hand for a split.
- Do not make registry construction asynchronous to bypass the walker.
  ADR 0008 requires the synchronous root for compile-time totality.
- The split tolerance guarantees flat statement weight over a preserved closure.
  It does not license additional eager edges beneath a façade.
  The head must still evaluate each merge-base module.
  The ADR-0019 checks remain mandatory.

## The conflict

[ADR 0008](0008-command-descriptor-registry.md) establishes `packages/command-registry/src/registry.ts` as the single **synchronous** descriptor root.
`RAW_COMMAND_DESCRIPTORS` and all derived views are module-scope values:

- The `Command` literal union.
- Catalog name sets.
- `name`-keyed policy maps.
- Batch policy.

Consumers reach these values through **value** imports.

`AGENTS.md` states that files beyond 1,000 lines are architecture debt and must split before new behavior.
The descriptor root exceeds that limit.

The ADR 0019 loading-shape probe, `scripts/__tests__/eager-closure-budgets.ts`, measures each published entry surface's eager **module count** against the committed merge-base.
It prohibits any increase and deliberately has no approval path for growth.
`APPROVED_OVER_CEILING` applies only to newly introduced entries against `NEW_ENTRY_CEILINGS`.

A hub split necessarily adds static value edges.
Every entry surface that reaches the hub gains the new modules.
These rules have no shared approval path.
One requires a file split; the other prohibits the resulting increase for every importer.

## Measured

A byte-faithful split moved `RAW_COMMAND_DESCRIPTORS` into eleven family modules and one shared trait module.
It preserved 79 of 80 descriptors byte-for-byte, including comments.
Every entry surface that reaches the root grew by exactly **+11** modules through this route:
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

Two facts make the increase unavoidable:

- Extraction of only the shared trait module, the smallest decomposition, adds **+1** on the same eleven surfaces.
  No decomposition of this hub passes the original rule.
- The walker excludes type-only edges.
  Narrower consumer imports cannot offset the increase because consumers need derived values, not types.

The increase is a module **count**, not additional evaluation weight.
The same bytes evaluate in either structure.
The gate proxy and file-size proxy conflict at precisely this structure, so the conflict needs an explicit decision.

## Decision

Byte-neutral relocation of hub contents may increase eager module count **if and only if the relocation is a split**.
Three facts determine eligibility from the closure graphs and merge-base tree, without a manually entered number:

1. **Containment.**
   The head closure evaluates every module in the merge-base closure, with canonicalized renames.
   It removes or replaces none.
2. **Added-module novelty.**
   Each module newly evaluated by the head is absent from the merge-base tree at its rename-canonicalized path.
   It must also carry no code from a source deleted since the merge-base.
   The check matches an added module when it shares two or more identical normalized top-level statements with one deleted source; that is a move signal.
   One shared statement counts as coincidence.
   Short constants, such as schema versions or default timeouts, repeat across the repository.
   Classification of every single-statement reuse as a move would incorrectly reject new files.
   A pre-existing module outside the closure that becomes eager is a new edge, not relocated closure code.
   This applies under its original path, a renamed path, or a rewritten move that escapes git `-M` pairing.
   Without novelty, weight deleted elsewhere in the closure would fund that new edge.
   Rename canonicalization preserves modules **already inside** the base closure.
   An external module moved inside fails at its base path, which remains present in the merge-base tree.
3. **Flat weight.**
   Total top-level statement count cannot exceed the merge-base closure's count.
   Wiring lines are excluded, so relocation is invisible to this count.

This implements #2469 candidate 4, structure ∧ weight.
Structure uses containment and novelty instead of candidate 2's importer-set structure.
Each incomplete combination has a counterexample:

- Containment without novelty permits a pre-existing external module at flat weight.
- Novelty without containment permits removal of a merge-base module.
- Weight without both structure checks permits unrelated shrinkage to fund an additional edge.

Together, the three facts permit extraction without increased module-scope statement weight.
Statements measure the preserved declarations and calls more accurately than bytes.
Formatting and comments change bytes without changing those statements.

The guarantee is exactly these facts:

- Newly evaluated modules are new code: their paths are absent from the merge-base tree.
- Each shares at most one coincidental statement with any source deleted since the merge-base.
- Total statement weight stays flat over a preserved closure.

`movedFromDeletedSource` deliberately uses the two-statement move threshold.
The guarantee does not establish equal eager behavior.
A split that replaces an existing statement in an existing file with a more expensive top-level call changes neither count nor weight.
Therefore it passes.
No count-based check, of modules or of statements, can detect a like-for-like replacement.
The remaining risk is bounded by new-path novelty and the transplant probe.
Any added module with two or more shared normalized statements from one deleted source counts as pre-existing code.

The probe is deliberately conservative and textual.
Code rewritten or reformulated during a move does not match the probe and would pass as novel.
It verifies "no verbatim transplant of a deleted source", not "no repurposed logic".
The weight check still refuses a heavier transplant.
Surrounding checks limit this residual risk:

- The hard ADR-0019 checks (façade exactness, no platform implementation before binding) remain count- and pattern-based.
- Each failure prints added modules for reviewer examination.
- `scripts/__tests__/closure-growth-rule.test.ts` pins every failing direction.

An ordinary extraction requires zero configuration edits.
The merge-base comparison recomputes all values without a per-split row, baseline, or number.
Candidate 3's approval-row design instead requires one manual row for each split, and its later retirement.

The `AGENTS.md` 1,000-line rule therefore needs no hub exception.
A statement-neutral split is shippable, so an oversized hub is addressable debt, not accepted state.

## Alternatives considered and refuted

- **An approved-growth row like `APPROVED_OVER_CEILING`, with issue, reason, and owner: refuted.**
  It is auditable but creates an allowlist for the one invariant that deliberately has no approval path.
  `AGENTS.md` prohibits such an allowlist to obtain a pass.
  Every split would also require a row and its retirement, unlike the chosen rule.
- **Structure alone, #2469 candidate 2: refuted.**
  The planted smuggle test shows that a "new" module can introduce a heavy eager edge.
  Containment proves nothing about eager work.
- **Containment and weight without novelty, the first #3298 draft: refuted.**
  The planted pre-existing-heavy test deletes statements elsewhere and funds a static edge to a pre-existing external module.
  That is actual growth, not a split.
- **Novelty from merge-base tree path alone, the second #3298 draft: refuted.**
  The planted rewritten-move test changes a path and formatting until git reports delete plus add.
  An absent destination therefore does not prove new code.
  Deleted-source statement comparison limits this gap at the explicit two-statement threshold.
  One identical statement is tolerated because short constants repeat.
  A statement-by-statement rewrite remains outside the textual probe.
  Only the deleted-source **list** is heuristic-free.
  Git supplies that list without any required similarity-pairing attempt.
  Content comparison still uses a threshold.
- **Weight alone, #2469 candidate 1: refuted.**
  The planted drop test replaces modules while retaining the same statement total.
- **Leave the array in place.**
  This is the status quo, not a resolution.
  It leaves the size debt without an owner and the conflict without documentation.
- **Function-scoped `await import` per family.**
  This passes by making registry construction asynchronous.
  It removes ADR 0008's compile-time totality and literal-union guarantees.
  A proxy improvement does not justify loss of a correctness guarantee.
- **Reduce descriptor verbosity instead of splitting.**
  This is legitimate but unexamined.
  It changes the declaration vocabulary for all approximately 80 commands, exceeds the split's scope, and needs a separate decision.

## Recovery

A complete byte-faithful split exists on pushed branch `refactor/collocation-registry-family-split`.
Its head is `40bf719a8b`, with split commit `ad3aaa520e`.
Acceptance makes that branch shippable.
Its +11 is a statement-neutral split with exactly the permitted structure.
It needs no gate change beyond this decision.
