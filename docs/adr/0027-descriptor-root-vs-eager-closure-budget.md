# ADR 0027: Descriptor Root Size vs Eager-Closure Budget (Proposed)

## Status

Proposed (2026-09-23). This ADR **decides nothing**. It records a conflict between two invariants
that are both enforced and both correct, and states the one question a repo owner must answer before
either invariant can be relied on for module placement. Until then, follow both: do not split the
descriptor root, and do not add an approval path to the budget gate to let the split through.

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

## Rules at a glance, while unresolved

- Do not split `registry.ts`. The budget gate is the binding constraint and has no waiver.
- Do not add an approved-growth row, a baseline entry, or a suppression to pass it. That is the
  allowlist `AGENTS.md` forbids.
- Do not make registry construction asynchronous to dodge the walker. ADR 0008's synchronous root is
  load-bearing for compile-time totality.
- Closure-neutral edits inside the descriptor root are still welcome: relocating guards beside the
  union they constrain, correcting stale claims, and moving non-eager content out are fine so long as
  every measured entry surface is unchanged.

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

## Decision required

May a byte-neutral re-homing of a hub module's contents into new modules raise the eager module count
of the entry surfaces that reach it — or must a hub module's contents stay inside the file its
consumers already evaluate?

Answering "the count may rise" needs a bounded, auditable growth allowance on an invariant that
currently refuses one. Answering "contents stay put" needs `AGENTS.md`'s 1,000-line rule to name the
exception for a hub whose consumers evaluate it as one unit, so the size is treated as accepted and
measured rather than as unaddressed debt. Either answer is fine; leaving it unstated means the next
agent at this file discovers the conflict from a red gate and picks one silently.

## Alternatives considered and refuted

- **Approved-growth row mirroring `APPROVED_OVER_CEILING` (issue, reason, owner):** refuted pending the
  decision above. It would be auditable, but it is an allowlist on the one invariant deliberately
  given no approval path, and `AGENTS.md` forbids adding one to obtain a pass.
- **Leave the array in place:** the status quo, not a resolution — it leaves the size debt unowned and
  the conflict undocumented.
- **Function-scoped `await import` per family:** passes the gate by making registry construction
  asynchronous, which removes the compile-time totality and literal-union guarantees ADR 0008 depends
  on. Trading a measured proxy cost for a lost correctness guarantee is the wrong direction.
- **Reduce descriptor verbosity instead of splitting the file:** legitimate and unexplored, but it
  changes the declaration vocabulary for all ~80 commands, which is a larger change than the split
  and needs its own decision.
