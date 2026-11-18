# Write tests

For iOS smoke, read [the guide](../../test/integration/ios-simulator-e2e/README.md).

## Choose the boundary

Before you add a test, name the observable behavior, invariant, or contract; the production edit that breaks it; and why existing coverage misses that edit.

For command behavior, prefer provider-backed integration through the real request path.
For native behavior, use the owning E2E lane.
For pure logic, types, or exhaustive cases, use focused tests.
If an existing scenario covers the regression, extend it.
Do not add test-only production exports or dependency injection.
Without the fix, a regression test must fail for the intended reason.
Prove it with [isolated experiments](test-experiments.md).
Pure moves keep their tests. Verify discovery at the new path.
Pair classifier positives with the closest negative.
Prove identical error text without the typed reason cannot trigger recovery.
For callback canaries, assert semantic success.
Automatic replay coverage needs a PR or scheduled lane that runs the scenario at the actual head.

Reject assertion-free probes, self-comparisons, subject-derived expectations, duplicate cases, and mocks that assert their own inputs.

Match test names to exercised inputs.
Type-only checks do not prove runtime behavior.
Retain compile-time `@ts-expect-error` pins.

## Fixtures and seams

Before you add helpers, check `@agent-device/test-kit` and `packages/daemon/src/__tests__/support/`.
Keep single-package fixtures beside their module.
Packages that test-kit depends on keep helpers local.
Do not import test-kit in a `vi.mock` factory for a module its entry loads.
Spy on that seam in place.
Use `mkdtempForTest` or `mkdtempForTestSync`.
After workers exit, global setup removes the run directory.
Mock the seam the subject consumes.
Daemon handlers receive fake runtime facts and facets, not generic dispatch mocks.
When you migrate an ADR 0019 command, move its tests to the runtime seam.

Vitest workers signal only themselves and direct children.
For fabricated PIDs, mock process-signal helpers.
To hide failures, do not disable isolation, switch the fork pool, or add unit retries.
Use existing clocks or tool seams, not production-time waits.
Slow-test pins only shrink. Justify a new pin with measurements.
Split tests by behavior.
Import the subject module, not a platform barrel.

## Run a focused test

Use `pnpm exec vitest run --project unit-core <path>`.
For `packages/apple-runner/src/**`, use `--project apple-runner`.
Local runs use four workers. To change that, set `AGENT_DEVICE_VITEST_MAX_WORKERS=<n>`. CI ignores it.
The root tsconfig includes scripts TypeScript.
Verify runner inclusion; typechecking does not prove collection.

For a provider scenario, use `pnpm exec vitest run --project provider-integration <path>`.
For device smoke, use the owning checked-in harness.

Wire changes that emit `platform` or `appleOs` need provider integration and coverage evidence.
