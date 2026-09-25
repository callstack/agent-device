---
name: test-audit
description: Write, change, review, or sweep tests. Authoring gate for new tests, plus an audit workflow and parallel subagent dispatch plan for finding tests that cannot fail, duplicating proof, or test-only production seams.
---

# Test audit

Three modes, one value criterion: a test earns its cost by guarding behavior, credible regressions, or independently meaningful contracts. Optimize for confidence, not deletion count.

## Authoring gate

Before adding a test, answer; if you can't, don't add it yet:

1. Which observable behavior, invariant, or independent contract does it guard?
2. Which credible regression makes it fail? Name the production edit.
3. Why doesn't existing coverage catch it? Each contract has one primary owner at the strongest boundary.
4. Does it need a production seam no production caller needs? Move the test to the real boundary instead.

Bug regressions must fail on pre-fix code for the intended reason. A regression test that never visibly failed is proving the mock.

## Junk patterns

Authoring rejects matches; audits hunt for existing matches:

- assertion-free probes; lone `typeof x === 'function'` followed by a sibling that calls `x`;
- self-comparison (`f(x)` vs `f(x)`, `map.get(k)` vs itself, fixture vs re-spelled fixture);
- expected value from the helper under test (oracle-as-expectation); a `switch` written in the test body;
- byte-identical or renamed `test()` blocks; the same golden replayed through a second entry point;
- type pins posing as runtime assertions: `Equal<A,B> = true`, `X ? true : never`, `satisfies` compared after erasure, `toHaveLength(n)` over test literals. Erase them mentally first; if nothing executable remains, convert to the `void [fixtures]` idiom;
- mocks asserting their own inputs; negative controls passing for the wrong reason;
- names promising more than the input exercises (an ordering claim with no ordering assertion is a repair candidate, not a deletion);
- dead code called only by tests; tests preserving test-only exports.

## Retention criteria

Keep (and refuse to delete) tests enforcing: command-registry/gate-manifest/layering/DI-seam completeness; golden tables and cross-language source inspection (`protocol.test.ts` grepping Obj-C is a real detector); `@ts-expect-error` pins (unused directives fail `tsc`, so they bite); deliberate identity pins where deep-equal doesn't subsume `toBe`; exact-array facets where a membership scan can't see duplicates; vocabulary pins that survive production+fixture co-updates. Static-or-slow isn't deletion-worthy; similarity to implementation isn't either — prove you can't break it.

## Candidate evidence

Record before editing; missing field ⇒ not ready:

- location + test name; detectable failure (or why none exists);
- non-test callers of covered seams; stronger remaining owner-boundary proof (quote both assertion sets, file:line, show superset relation);
- skip guards in candidate and sibling (`skipIf`, `.skip`, `AGENT_DEVICE_*` env, whether any workflow or script sets it);
- which Vitest project includes the file (`unit-core`, `apple-runner`, `provider-integration`, `fuzz-worker`, `interaction-contract`, `output-economy`) — unmatched = never-run finding; note: `macos.yml` names its darwin files explicitly;
- unlock deletion; focused validation command; risk.

## Mutation discipline

The audit's core proof: plant a production edit that represents the bug the test claims to catch; the pre-edit body must stay green while the post-edit body goes red. Report both counts (`8 passed` → `1 failed | 7 passed`). Revert and show `git status` clean before committing. For deletions, prove the sibling catches the mutant. Never argue detection — measure it.

## Validation

This repo's commands (upstream `run-vitest.mjs`/`check-changed.mjs` don't exist):

1. Focused: `npx vitest run --project unit-core <path>` (or `--project apple-runner` for `packages/platform-apple/src/runner/**`).
2. `pnpm format` (whole repo), `npx oxlint . --deny-warnings`, `npx tsc -b packages/...` for package edits, `npx tsc -p tsconfig.json` for `src/`.
3. `pnpm check:affected --run` at the pushed commit; `pnpm check:fallow --base origin/main` when touching production exports.
4. `git diff --numstat`; report production/test deltas separately.
5. Don't edit during Vitest runs; `scripts/**` tests are outside `tsc` scope — type-check new helpers there explicitly.

## Dispatching subagents

For broad scope, run parallel read-only lanes and keep editing ownership exclusive:

- subsystem lanes (platform packages; `src/daemon`; contracts/kernel/registry/capture-kit/selectors; `test/integration` + maestro/ad-replay/session-journal + provider packages; `scripts/**`);
- one cross-cutting pattern sweep (junk-pattern greps across all tests, each hit read and confirmed);
- one never-run inventory (project includes, gate ownership via `scripts/gate` and `.github/workflows`, unsatisfiable guards).

Mandate in every prompt: READ-ONLY; read the production owner and name the bug; verify skip guards and project selection; retention list above verbatim; "a false positive costs more than a miss"; output capped, highest-confidence first, with validation commands.

## Landing

One coherent owner-boundary batch per PR; prefer net-negative production LOC; delete the test-only seam with the test. Push only when authorized; rebase on review feedback and answer findings by fixing the rule, not the cited site. After landing, rebase to `main` and rediscover; don't carry stale candidate lists.

## Handoff

Report: categories deleted; owner simplifications; retained false positives with reasons; mutations run with before/after counts; production vs test LOC; PR state; named follow-ups needing owner judgment (never-run env gates, tsconfig coverage gaps, suspected product bugs).
