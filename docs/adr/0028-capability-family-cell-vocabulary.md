# ADR 0028: Capability-Family Cell Vocabulary — Retain Compile-Checked Declarations

## Status

Accepted (2026-10-29): retain the compile-checked declarations.
The proposed single-source cell table is rejected as a solution to cross-owner capability fan-out.

## Rules at a glance

Retain the authored input properties and the compile-checked `UNAVAILABLE_CELLS` table.
[ADR 0019](0019-request-bound-platform-runtime.md), section 2, retains exhaustive owner facts for the exact device shape.
A cell-key declaration must not derive an owner's availability answer.
A missing required cell remains a bug.
The existing optional cells retain their `network` fallback in `freezeUnavailableFacts`.
This decision adds no default behavior or cross-family default denial set.

Lifecycle retains separate authority.
`platform-runtime-unavailable.ts` does not assign lifecycle semantics.
No generator or vocabulary move is introduced.
[ADR 0027](0027-descriptor-root-vs-eager-closure-budget.md) still governs any future eager-closure change.

## Decision and reason

[The bounded measurement](../evidence/capability-cell-vocabulary-2026-10-29.md) found no file or package saving.
It was a cell-level surrogate, not the proposed next-family experiment or a whole-feature replay.

`platform-runtime-unavailable.ts` declares input properties and repeats their keys in a value table.
The `satisfies` check makes key disagreement a compile error.
This duplicate is a maintenance cost, not a soundness defect.

A local runtime table can derive the input type and remove one authored key declaration.
Both declarations already occupy the same file and package.
The measured substitution therefore did not reduce the coordination boundary.
It also replaced the explicit input contract with required/optional metadata and mapped types.
Unchanged eager closures do not establish a coordination or quality benefit.

The proposal required a visible reduction in fan-out before acceptance.
Its closing rule required rejection if that reduction did not occur.
The bounded result does not justify adoption.

## Consequences

Keep the explicit input contract and the exhaustive key table synchronized.
A future proposal needs evidence that duplicate vocabulary causes an avoidable file or owner edit.
Family-level cells can already accommodate new operations without a new cell key.
Rejecting this table does not reject every future vocabulary design.

Decision history: The 2026-09-23 proposal was rejected after [the bounded retain decision in #4056](https://github.com/callstack/agent-device/issues/4056#issuecomment-6499398178).
