# ADR 0028: Capability-Family Cell Vocabulary — One Runtime Source (Proposed)

## Status

Proposed (2026-09-23). Proposes inverting one vocabulary so adding a capability family is a single
declaration instead of a coordinated edit across a type, a table, and every runtime owner. It decides
**no** defaulting behavior, and it does not weaken any ADR 0019 rule. Ship only after the measurement
below shows the fan-out actually shrinks.

## Why now, and what the numbers said

Over the last 200 commits, 8 commits touched eight or more packages, across only five distinct
package combinations — and one of those combinations recurred four times. Each was one capability
(`action-button`, `fold`, preferred text size) propagating through every runtime owner. Within
`@agent-device/contracts`, `platform-runtime-unavailable.ts` churned 9 times with fan-in of only 6:
the most-changed file in the repo that almost nothing imports. That signature is a declaration site
paying a coordination tax, not a behavioral hotspot.

## What is actually duplicated

Not the behavior — the **cell vocabulary**. Adding one operation family currently means editing, in
`@agent-device/contracts`:

1. the family's own `xxx-runtime.ts` fact builder,
2. `UnavailablePlatformRuntimeFacts` (`platform-runtime-unavailable.ts`) — a type property,
3. `UNAVAILABLE_CELLS` in the same file — a `{ cell: true } satisfies Record<UnavailableCellKey, true>`
   value listing the same keys again, because a type's key set cannot be enumerated at runtime,
4. `PlatformRuntimeOperations`,
5. `runtime-operation-names.ts`,
6. one row in `INTERACTOR_OPERATIONS`.

(2) and (3) are the same list written twice. `satisfies` makes drift a compile error, so this is **not**
a soundness hole — it is a maintenance tax paid on every family. A runtime row table would make the
value authoritative and the type derived from it.

The repo has already done exactly this inversion once, and should copy it rather than invent:
`interactor-operation-catalog.ts` replaced "three parallel declarations — a name tuple, a local binder
map, and a provider binder map" with `INTERACTOR_OPERATIONS`, one row per operation. The binding axis
is single-sourced. The **facts** axis is not.

## Rules at a glance

- One runtime row per capability family is the authority for its cell key; the cell-key type is
  derived from that table, not maintained beside it.
- A runtime owner still reports **exhaustive** facts for its exact device shape
  ([ADR 0019](0019-request-bound-platform-runtime.md), section 3). Deriving the *list of cells* is
  allowed; deriving an owner's *answer* for a cell is not.
- No cross-family default denial set. An owner that does not state a cell is a bug, not an
  unsupported result.
- Lifecycle keeps its own authority. `platform-runtime-unavailable.ts` exists "for provider ownership
  gaps" and never assigns lifecycle semantics; that stays out of the table.

## Explicitly not proposed

- **A default-deny baseline owners inherit.** ADR 0019 requires exhaustive per-shape facts and forbids
  cross-family defaults in a platform package, so the current ~35-cell enumeration in an owner such as
  `packages/platform-linux/src/runtime.ts` is intentional. Removing it needs an ADR that supersedes
  those two rules on the merits, not a table that quietly reimplements them.
- **Moving the vocabulary out of `@agent-device/contracts`.** It already lives at the lowest ranked
  zone; the `depgraph` README's 42→48 lesson applies — moving a vocabulary file down made the gate
  worse because the vocabulary itself imports upward.
- **A new generator.** The catalog precedent is a hand-written row array with derived views.

## Measurement required before acceptance

This ADR exists to stop an eight-package fan-out. Before landing any inversion, measure on a real
family rather than arguing from the shape:

1. Pick the next capability family. Land only the single-source cell vocabulary (steps 2-3 above).
2. Report the change in files-touched for that family against the recorded baseline of the four
   recurring eight-package commits.
3. Report eager-closure deltas per entry surface. `scripts/__tests__/eager-closure-budgets.ts` has no
   growth-approval path, and [ADR 0027](0027-descriptor-root-vs-eager-closure-budget.md) shows a
   byte-neutral re-home can be unshippable here. A row table is a **new eager value**; if it costs
   closure slots, it is blocked on the same ground and this ADR should be withdrawn rather than
   granted an exception.

If the fan-out does not visibly shrink, close this as rejected and leave the two authored lists in
place — a compile-checked duplicate is a legitimate resting state.
