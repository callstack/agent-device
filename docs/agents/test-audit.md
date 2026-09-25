# Test Audit

A test earns its cost by guarding behavior, credible regressions, or independent contracts. Optimize for confidence, not deletions. Gate selection stays in `docs/agents/testing.md`.

## Authoring gate

Answer all before adding a test:

1. Which observable behavior, invariant, or independent contract does it guard?
2. Which credible regression makes it fail? Name the production edit.
3. Why doesn't existing coverage catch it? Each contract has one owner at its strongest boundary.
4. Does it need a production seam no production caller needs? Move the test to the real boundary.

A bug regression must fail on pre-fix code for the intended reason; one that never failed visibly proves the mock.

## Junk patterns

Authoring rejects; audits hunt:

- assertion-free probes; a lone `typeof x === 'function'` above the sibling calling `x`;
- self-comparison (`f(x)` vs `f(x)`, `map.get(k)` vs itself, fixture vs re-spelled fixture);
- expectation drawn from the helper under test; a `switch` in the test body compared to its arms;
- near-identical or renamed `test()` blocks; one golden replayed twice;
- type pins posing as runtime assertions (`Equal<A,B> = true`, `X ? true : never`, `satisfies` after erasure, `toHaveLength(n)` over literals); if erasing leaves nothing executable, use `void [fixtures]`;
- mocks asserting their own inputs; negative controls passing for the wrong reason;
- names promising more than the input exercises;
- dead code called only by tests; tests preserving test-only exports.

## Retention criteria

Refuse to delete tests enforcing: registry, gate-manifest, layering, and DI-seam completeness; golden tables and cross-language source inspection; `@ts-expect-error` pins (an unused directive fails `tsc`); identity pins deep-equal can't subsume; exact-array facets a membership scan can't see duplicates in; vocabulary pins surviving a production+fixture co-update. Static-or-slow and implementation-similarity are not deletion-worthy: prove you can't break it.

## Candidate evidence

Record before editing; a missing field blocks the edit:

- location, test name, detectable failure (or why none);
- non-test callers of the covered seams; the stronger remaining owner proof (both assertion sets, `file:line`);
- skip guards in candidate and sibling (`skipIf`, `.skip`, env flags a workflow sets);
- the runner that executes the file: a Vitest project (`vitest.config.ts`), a `node --test` script (`test:smoke`, `check:*:test`), native XCTest, or a `CHECK_CATALOG` gate id. Only a file no runner reaches is a never-run finding;
- what deletion unlocks; risk.

## Mutation discipline

Plant the production edit representing the claimed bug: the pre-edit body must stay green while the post-edit body goes red. Report both counts (`8 passed` → `1 failed | 7 passed`). Revert and show `git status` clean before committing. For a deletion, prove the sibling catches the mutant. Never argue detection: measure it.

## Focused validation

`pnpm exec vitest run --project unit-core <path>`, or `--project apple-runner` for `packages/platform-apple/src/runner/**`; then `pnpm check:quick` and `pnpm check:affected --run` on the pushed commit. `scripts/**` tests are in no `tsconfig` include, so `pnpm typecheck` skips helpers there.

## Dispatching subagents

Run parallel read-only lanes with exclusive edit ownership: subsystem lanes (per platform package, `src/daemon`, core packages, `scripts/**`), one cross-cutting junk-pattern sweep, one never-run inventory (Vitest includes, `node --test` globs, gate ids). Mandate in every prompt: READ-ONLY; read the production owner and name the bug; verify skip guards and runner/gate ownership; paste the retention list; false positives cost more than misses.

## Landing

One owner-boundary batch per PR; delete the test-only seam with the test; prefer net-negative production LOC. Report retained false positives, then rebase to `main` and rediscover.
