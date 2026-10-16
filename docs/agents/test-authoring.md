# Write tests

Read [validation](testing.md) for checks and [test audits](test-audit.md) for deletions.

## Choose the boundary

Before adding a test, name:

1. The observable behavior, invariant, or independent contract.
2. The production edit that would break it.
3. Why existing coverage does not catch that edit.

Test through the strongest production boundary. Do not add test-only production exports or dependency injection.
A regression test must fail without the fix for the intended reason. Use [isolated experiments](test-experiments.md).
Pure moves retain their tests; verify discovery at the new path.
Pair classifier positives with the closest negative. Prove identical error text without the typed reason cannot trigger recovery.
For callback canaries, assert semantic success, not lifecycle completion.
Automatic replay coverage requires a PR or scheduled lane that runs the scenario at the actual head.

Reject assertion-free probes, self-comparisons, expectations computed by the subject, duplicate cases, and mocks asserting their own inputs.
Reject tests whose names promise more than their inputs exercise. Type expressions erased at runtime do not prove runtime behavior.
Retain compile-time `@ts-expect-error` pins; an unused directive fails typechecking.

## Fixtures and seams

Look in `@agent-device/test-kit` and `packages/daemon/src/__tests__/support/` before adding helpers.
Keep single-package fixtures beside their module. Packages that test-kit depends on keep helpers local.
Do not import test-kit in a `vi.mock` factory for a module its entry loads. Spy on that seam in place.
Use `mkdtempForTest` or `mkdtempForTestSync`. Global setup removes the run directory after workers exit.
Mock the seam the subject consumes. Daemon handlers receive fake runtime facts and facets, not generic dispatch mocks.
When migrating an ADR 0019 command, move its tests to the runtime seam.

Vitest workers signal only themselves and direct children. Mock process-signal helpers for fabricated PIDs.
Do not disable isolation, switch the fork pool, or add unit retries to hide failures.
Use existing clocks or tool seams instead of waiting production time.
Slow-test pins only shrink; a new pin needs measured justification.
Do not extend test files over 1,000 lines.
Import the subject module, not a platform barrel.

## Run a focused test

Use `pnpm exec vitest run --project unit-core <path>`.
For `packages/platform-apple/src/runner/**`, use `--project apple-runner`.
Local runs default to four workers. Set `AGENT_DEVICE_VITEST_MAX_WORKERS=<n>` for a different host share; CI ignores it.
Scripts tests are outside root TypeScript includes. Check new helpers with their runner and review their types.

Wire changes emitting `platform` or `appleOs` need provider integration and coverage evidence.
