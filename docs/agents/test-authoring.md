# Write tests

For checks, read [validation](testing.md).
For deletions, read [test audits](test-audit.md).

## Choose the boundary

Before you add a test, name:

1. The observable behavior, invariant, or independent contract.
2. The production edit that would break it.
3. Why existing coverage does not detect that edit.

Test through the strongest production boundary.
Do not add test-only production exports or dependency injection.
Without the fix, a regression test must fail for the intended reason.
Use [isolated experiments](test-experiments.md).
Pure moves retain their tests. Verify discovery at the new path.
Pair classifier positives with the closest negative.
Prove identical error text without the typed reason cannot trigger recovery.
For callback canaries, assert semantic success, not lifecycle completion.
Automatic replay coverage requires a PR or scheduled lane that runs the scenario at the actual head.

Reject these tests:

- Assertion-free probes.
- Self-comparisons.
- Expectations computed by the subject.
- Duplicate cases.
- Mocks that assert their own inputs.

Reject tests whose names promise more than their inputs exercise.
Type expressions erased at runtime do not prove runtime behavior.
Retain compile-time `@ts-expect-error` pins. An unused directive fails typechecking.

## Fixtures and seams

Before you add helpers, examine `@agent-device/test-kit` and `packages/daemon/src/__tests__/support/`.
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
Do not disable isolation to hide failures.
Do not switch the fork pool to hide failures.
Do not add unit retries to hide failures.
Use existing clocks or tool seams instead of production-time waits.
Slow-test pins only shrink. A new pin needs measured justification.
Do not extend test files over 1,000 lines.
Import the subject module, not a platform barrel.

## Run a focused test

Use `pnpm exec vitest run --project unit-core <path>`.
For `packages/platform-apple/src/runner/**`, use `--project apple-runner`.
Local runs default to four workers.
For a different host share, set `AGENT_DEVICE_VITEST_MAX_WORKERS=<n>`. CI ignores it.
Scripts tests are outside root TypeScript includes.
Check new helpers with their runner. Review their types.

Wire changes that emit `platform` or `appleOs` need provider integration and coverage evidence.
