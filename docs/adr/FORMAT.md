# ADR format — read this before you write or amend an ADR

An ADR records one accepted decision. It states: what was decided, why, what was rejected, and what follows.

## When to write one

Write an ADR only when all three conditions are true:

1. The decision is hard to reverse. Changing it later costs real work.
2. The decision is surprising without context. A future reader would ask "why this way?"
3. The decision is the result of a real trade-off. Genuine alternatives existed.

If one condition is missing, do not write an ADR.

Keep a proposal in an umbrella issue. Write the ADR when the decision is accepted. An ADR records accepted decisions only.

Write a new ADR only when the problem or the scope changes. Amend the existing ADR otherwise.

## What an ADR contains

Every ADR states four things:

1. The decision: the API, data flow, invariants, constraints, or boundaries. State only what explains the decision.
2. The reason for the decision.
3. The rejected alternatives, each with its reason.
4. The consequences and the open gaps.

Keep exact technical names (commands, flags, wire fields, typed reasons) where they explain the decision.

Sections are optional. A short paragraph that holds the four things is a complete ADR. Do not add empty sections. Do not put an audit report in an ADR.

## What an ADR excludes

Do not record these in an ADR. Send each to its owner:

- Implementation inventories and file maps: the registries, types, and gates that own them.
- Measurements: `docs/evidence/`.
- Rollout and migration plans: the package docs, the help, or the umbrella issue.
- PR logs and status change-logs: the umbrella issue.

Do not repeat general repo guidance that `AGENTS.md` already gives.

## The record stays current

An ADR states the current truth. It is not a log of the discussion around the decision. An optional dated "Decision history" line records a real change of direction. If the direction really changed, you may add one such line with its reason and a link.

## Before you amend

1. Check the current code against the decision the record intends to keep.
2. Check the code comments and issues that cite the record.
3. If the code changed on purpose: update the record to the new truth. Record the reason. When the direction changed, you may add the optional "Decision history" line.
4. If the code drifted by mistake: record the drift in an issue. Keep the constraint in the record.
5. Preserve constraints that the code cannot show.
6. If you change a section name or a decision number, update the code citations that point at it.

An amendment that changes the modality, scope, or exceptions of an accepted decision must say so explicitly. Keep proposed wording as proposed.

## How to restructure an existing record

- Keep a migration ledger. Map each old section to one outcome: kept, moved to a named owner, or deleted with a reason.
- Before a deletion, move content that is the only home of a still-true contract to its owner.
- Keep one PR to one to three related ADRs.

## Size and naming

Keep ADRs short. Aim below about 8 KB.

Name files `NNNN-slug.md` in `docs/adr/`. Scan the directory and use the next number. Add a row to the index in `docs/adr/README.md`.
