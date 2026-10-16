# ADR 0028: Capability-Family Cell Vocabulary — One Runtime Source (Proposed)

## Status

Proposed (2026-09-23).
This ADR proposes to invert one vocabulary.
Then a new capability family needs a single declaration, not a coordinated edit across a type, a table, and every runtime owner.
It decides **no** defaulting behavior, and it does not weaken any ADR 0019 rule.
Ship only after the measurement below shows that the fan-out actually decreases.

## Why now, and what the numbers said

Of the last 200 commits, 8 affected at least eight packages.
They used only five distinct package combinations.
One combination recurred four times.
Each change propagated one capability through every runtime owner: `action-button`, `fold`, or preferred text size.

Within `@agent-device/contracts`, `platform-runtime-unavailable.ts` changed 9 times but had only 6 importers.
It was the most-changed file in the repository that almost nothing imports.
This pattern shows a declaration site that pays a coordination cost, not a behavioral hotspot.

## What is actually duplicated

The duplicate is **cell vocabulary**, not behavior.
A new operation family currently requires these `@agent-device/contracts` edits:

1. The family's `xxx-runtime.ts` fact builder
2. A type property in `UnavailablePlatformRuntimeFacts` (`platform-runtime-unavailable.ts`)
3. The same keys in that file's `UNAVAILABLE_CELLS`, a `{ cell: true } satisfies Record<UnavailableCellKey, true>` value
4. `PlatformRuntimeOperations`
5. `runtime-operation-names.ts`
6. One `INTERACTOR_OPERATIONS` row

Items 2 and 3 duplicate one list because runtime cannot enumerate type keys.
`satisfies` makes disagreement a compile error.
This is a maintenance cost, not a soundness defect.
A runtime row table would own the values and derive the type.

The repository already uses this inversion in `interactor-operation-catalog.ts`.
`INTERACTOR_OPERATIONS` replaced three declarations: a name tuple, local binder map, and provider binder map.
The binding axis has one source.
The facts axis does not.
The proposal should copy this existing design and not invent a new one.

## Rules at a glance

This ADR proposes these rules:

- One runtime row per capability family owns its cell key.
  The table derives the cell-key type instead of a separately maintained type.
- Each runtime owner still reports exhaustive facts for its exact device shape under [ADR 0019](0019-request-bound-platform-runtime.md), section 3.
  Derivation may enumerate cells.
  It must not derive an owner's answer for a cell.
- There is no cross-family default denial set.
  If an owner does not state a cell, that omission is a bug, not an unsupported result.
- Lifecycle retains separate authority.
  `platform-runtime-unavailable.ts` exists "for provider ownership gaps" and never assigns lifecycle semantics.
  Lifecycle stays out of the table.

## Explicitly not proposed

This proposal excludes these changes:

- **Inherited default-deny baseline.** ADR 0019 requires exhaustive per-shape facts and forbids platform-package cross-family defaults.
  Thus, the current enumeration of about 35 cells in an owner, such as `packages/platform-linux/src/runtime.ts`, is intentional.
  Removal needs an ADR that supersedes those two rules on the merits.
  A table that quietly reimplements them is not sufficient.
- **Vocabulary outside `@agent-device/contracts`.** It already occupies the lowest ranked zone.
  The `depgraph` README's 42→48 example applies.
  Moving vocabulary downward worsened the gate because its imports pointed upward.
- **New generator.** The existing catalog uses a hand-written row array with derived views.

## Measurement required before acceptance

This ADR exists to stop an eight-package fan-out.
Before you introduce any inversion, measure a real family.
Do not argue from the shape alone:

1. Select the next capability family.
   Introduce only the single-source cell vocabulary, items 2-3 above.
2. Report the change in files touched for that family.
   Compare it with the recorded baseline of the four recurring eight-package commits.
3. Report eager-closure differences for each entry surface.

`scripts/__tests__/eager-closure-budgets.ts` has no growth-approval mechanism.
[ADR 0027](0027-descriptor-root-vs-eager-closure-budget.md) permits module-count growth only under all three conditions:

- The head closure preserves every merge-base module.
- Each newly evaluated module is new to the merge-base tree or is a rename.
- Total module-scope weight does not increase.

A row table is a **new eager value**.
It must satisfy all three conditions to pass.
If it does not satisfy them, the gate stays red.
In that case, this ADR should be withdrawn, and it should not get an exception.
If the fan-out does not visibly decrease, close this ADR as rejected and retain both authored lists.
A compile-checked duplicate is a legitimate resting state.
