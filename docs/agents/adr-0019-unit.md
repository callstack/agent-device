# Migrating one command onto the request-bound platform runtime (ADR 0019 unit)

The checklist for one command unit. ADR 0019 §6–10 holds the rules and the why; issue #1739 holds
the wave plan and per-unit budgets; this file is the order of operations, with the seam, fixture,
and gate you touch at each step. Everything here was rediscovered during the `snapshot` unit
(#1779, 134 files) — do not rediscover it again.

## Before writing code

1. **Post the unit on #1739 first**: exact denominator (every inventory source or supported
   device-runtime cell), parity source, facet owner, expected deletions, evidence tier
   (request-scoped vs durable-resource), and the size budget. A unit without a posted budget has
   no acceptance criterion; the late budget negotiation on #1779 is the incident.
2. **One integration owner.** Parallel agents audit (platform parity, tests, size, architecture)
   and implement only clearly disjoint lanes — a platform package's operations, a fixture builder,
   the test migration. The shared spine — plan → facts → bind in the handler, the descriptor's
   `platformExecution`, the cutover row — moves serially under one owner. Two agents editing the
   spine produced the rebase churn on #1779.
3. **Ask the owning-interface question before adding any gate**: "can this invariant be made
   impossible at the seam (a type only one function can produce, a required parameter, one
   construction path)?" If yes, do that; a cutover-row *extension* that recognizes a call shape is
   the fallback, not the default, and it is what AGENTS.md's "reconstructing a compiler" principle
   forbids once it needs a second omission patch.

## The unit, in order

Each step names its declaration site; read that, not prose.

| Step | Where |
| --- | --- |
| Declare the use(s) with the one neutral `defineUse`; required-only by default, a preferred operation needs a recorded measurement in the unit review (§9) | `packages/contracts/src/platform-runtime-operations.ts` |
| Plan resolution is pure and lives in contracts (`resolve<Command>RuntimePlan`), never in the handler | `packages/contracts/src/*-runtime-plan.ts` |
| Handler: resolve plan → `inspectRequiredRuntimeUse({ device, use: plan.use, inspectFacts })` → on `admitted`, bind **once** with that plan's use → operate. No admission-only binds, no `requireCommandSupported`, no capability bucket. (#1841 replaces this with `admitRuntimePlan({ device, plan, inspectFacts })`, whose returned token names both device and plan and is what the binder requires; this row follows it when it lands) | `src/daemon/handlers/session-runtime-admission.ts`; the `snapshot` route in `src/daemon/snapshot-runtime.ts` + `snapshot-runtime-binding.ts` as the model |
| Descriptor flips to `platformExecution: { kind: 'device-runtime', use(s) }` in the same PR; the discriminator is exhaustive, so a forgotten descriptor fails typecheck | `src/core/command-descriptor/registry.ts` |
| Each platform package reports exact-owner facts and implements the operations; provider ownership fails closed (missing behavior never falls through to a local owner) | `packages/platform-*/src/**`, `packages/provider-*/src/**` |
| Add one row to the parametrized cutover table: `legacyRetirement` (what must be gone), `runtimeTypeNames`, `operations`, `singularExecution` with lexical `operationOwners`. The mechanism already carries the planted-red proof; a row that leaves a claim unstated is rejected by `cutoverRowDefects` | `scripts/layering/runtime-command-cutover-table.ts` (rule ids allocate upward; snapshot is R32) |
| Delete: the legacy adapter, the descriptor's capability bucket + `requireCommandSupported` wiring, the retired route names — the row's `legacyRetirement` is the machine-checked list | wherever `legacyRetirement` points |
| Tests: bind a fake runtime at the seam the handler consumes (`inspectFacts` / `bindDevice`), never a `dispatchCommand` mock. Move the command's existing tests off the dispatch mock in this PR | `src/daemon/__tests__/snapshot-runtime-fixture.ts` (fixture shape), `src/daemon/handlers/__tests__/session-command-harness.ts` (`mockInspectDeviceRuntimeFacts`, `mockBindDeviceRuntime`), `src/__tests__/test-utils/runtime-operation-facts.ts` (facts builders) |
| Cross-cutting facets (freshness, system-chrome guard, presentation) land inside the first consuming unit and get one contract owner; later units consume, never fork | ADR 0019 §10 |

## Evidence the unit review must contain

- Request-scoped tier: the typed use declaration, fact coverage for every denominator cell, the
  enumerated legacy-parity cell table, and the cutover-gate row. Durable-resource tier adds ADR
  §4–5 lifecycle evidence. Importing durable machinery promotes the tier — say so.
- Planted-red for anything new that is *not* a table row (a facet, a package boundary): revert,
  run, quote the failing line. A row needs no planted-red of its own.
- Size: root-bytes-removed vs package-bytes-added and the four checkpoint metrics
  (`pnpm size --compare` against the base build), against the posted budget. Move-dominated is the
  rule; net growth is itemized, not explained away.
- Live evidence for the changed path on at least one real target per family the denominator
  claims (`docs/agents/device-verification.md`); fixture-backed parity does not replace it.
- Layering: `pnpm check:layering` green — R3 seam list narrows in the unit that removes an area's
  last platform import and never grows; R9/R10 must not grow (`docs/agents/testing.md`).

## What "done" is not

- A migrated command with a legacy fallback, a provider/local fallback, or a `dispatchCommand`
  branch left "just in case" — the row's retirement claim rejects it, and so does review.
- Tests green because they mock the old seam. Grep the command's name across
  `vi.mock('.../core/dispatch.ts')` users before calling the tail closed.
- A per-command policy file in `scripts/layering/`. If the row's generalized columns cannot
  express the invariant, first return to step 3; extensions are the exception and each one names
  what the seam could not make impossible.
