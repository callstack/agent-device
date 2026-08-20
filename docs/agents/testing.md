# Testing Notes

This file contains the repository-specific testing traps a contributor cannot derive from the test
runner alone. Executable gate ownership lives in `scripts/check-affected/` and `scripts/gate/`.

## Which gates a change needs

Use three tiers:

1. While editing, run a focused test or `pnpm check:quick`.
2. Before pushing, run `pnpm check:affected --run`. It derives relevant local gates and reports
   checks owned by CI or a native toolchain.
3. For a broad refactor or explicitly requested full deterministic gate, run `pnpm check`.

GitHub remains authoritative for provider integration, full coverage, native builds, device lanes,
and history-backed compatibility. To inspect the current gate catalog or a plan, use:

`check:affected --run` reports coverage obligations but never enables coverage instrumentation. It
runs one capped `vitest related` command for local feedback; run the dedicated coverage scripts only
when diagnosing a red CI result.

```sh
pnpm check:affected
pnpm check:affected --json
pnpm gate --help
```

Two selection traps recur:

- A response that emits `platform` or `appleOs` needs provider integration and coverage evidence;
  unit tests do not run the provider project that catches internal `apple` leaking onto the wire.
- A workspace package manifest or TypeScript config can rewire all consumers, so the affected
  selector deliberately fails open to the full gate set.

Docs-only changes with no behavior impact need no runtime tests. Structural guidance gates still
need a planted violation that demonstrates their failure direction.

## Platform and live-device policy

HarmonyOS has no provisioned CI emulator, physical device, DevEco image, or HDC installation. Unit,
provider, and coverage tests mock the typed HDC seam; real validation is local hardware evidence
following `docs/agents/device-verification.md`. Do not add a CI lane that assumes a developer host.

Apple runner changes run `pnpm check:xctest-selection` and build the affected target. The source
`#if` guard is the XCTest lane classification; do not maintain a second test-name list. Pure runner
decisions use the macOS host lane, while iOS/XCTest semantics require a simulator lane.

Local host-lane XCTest runs hit two snags CI never does. System policy may refuse the unsigned
bundle (`library load disallowed by system policy`, surfacing as `Early unexpected exit … crashed
with signal kill`); rebuild signed, with `CODE_SIGN_IDENTITY="Apple Development"` or a manual
identity from `security find-identity -v -p codesigning`. The first run also needs XCUITest
automation permission for the host app.

Live smoke commands and their environment contracts live with their harnesses:

- web: `test/integration/smoke-web-platform.test.ts`
- iOS: `test/integration/smoke-ios-simulator.test.ts` and
  `test/integration/smoke-ios-simulator-coverage.test.ts`
- concurrency: `test/integration/nightly/concurrency-torture.test.ts`

Read those entry files before running a lane; do not copy their changing environment matrix here.

## Shared test utilities

Before creating fixtures, inspect `src/__tests__/test-utils/index.ts` and import its named builders
through the barrel. Shared `DeviceInfo`, session, snapshot, store, runtime-fact, and mocked-binary
values belong in a sibling fixture module rather than repeated test literals.

Use `mkdtempForTest` or `mkdtempForTestSync`. The Vitest global setup redirects `TMPDIR` for the
whole run and removes it after every worker finishes; do not add per-test cleanup for directories
those helpers create. An interrupted run may leave a directory temporarily, and the next run prunes
it only after both the owner process and every process using its `TMPDIR` are gone.

Mock the seam the subject consumes. A daemon handler that binds a runtime gets fake runtime facts and
facets, not a mock of generic dispatch. The old generic dispatch mocks are migration debt; do not add
to them. When an ADR 0019 command migrates, its tests move to the runtime seam in the same PR.

Vitest workers may signal only themselves and direct children. `hermetic-signal-setup.ts` rejects
other process-table writes. Tests with fabricated PIDs mock `signalPidsBestEffort`,
`signalProcessGroupBestEffort`, or the tool-provider seam; a real child spawned by the test may be
signalled directly.

## Regression evidence

A regression test must be observed failing without the production change. Revert the implementation,
run the smallest owning test, record the failing test count, then restore it. Apply the same proof to
test relocation and structural gates: plant a type error or violation and verify the intended gate
discovers and names it.

A callback-based canary must observe the subject's semantic success state, not merely lifecycle
completion. For example, React Native Gesture Handler's
[`onFinalize`](https://docs.swmansion.com/react-native-gesture-handler/docs/fundamentals/callbacks-events/)
also runs when recognition fails or is interrupted; use an activation-dependent callback or assert
the callback's success state before publishing a passing result.

A device replay is automatic regression coverage only when an automatic PR or scheduled lane selects
and executes it. Name the owning lane and confirm the scenario ran on the exact PR head; placing a
replay in a manual or otherwise unselected tier is test material, not automatic evidence.

For structured classifiers, pair the positive case with the closest negative case. When an error
message can be identical with and without a typed reason, the negative test must prove the message
alone cannot activate retry, fallback, or recovery.

Tests use public interfaces where practical. Do not create production exports or test-only dependency
injection solely for a test; a missing seam must be a real product seam.

## Properties, fuzzing, and mutation

Pure parser and geometry changes extend shared fast-check arbitraries and properties rather than
adding only another example. Keep examples for a real past bug or named decision. Reuse
`PROPERTY_RUNS` budgets so property files stay within the unit slow-test gate.

Parser fuzz targets live in `scripts/fuzz/targets.ts`; validation generators carry the invalid
outcome they planted, so silent acceptance and wrong error codes are failures. Promote a discovered
case through the command printed by the harness rather than hand-copying an unshrunk input.

Mutation is report-only and limited to the registry in `scripts/mutation/modules.ts`. Use it to
measure whether tests distinguish changed decision logic; do not infer redundancy from line coverage
alone.

## Before editing a shared module (`pnpm depgraph affected`)

Run the dependency query before touching a high-fan-in module:

```sh
pnpm depgraph affected src/utils/exec.ts
pnpm depgraph affected src/daemon/ref-frame.ts --json --limit 25
```

It reports value-edge dependents, affected gates, public commands whose handler chains reach the
module, live scenario owners, and interaction-guarantee cells. Type-only and dynamic edges are
classified separately. Run the resulting plan through `pnpm check:affected --run`; do not maintain a
parallel gate list in prose.

## Gate ownership

`CHECK_CATALOG` is the executable check registry. CI owns a check only through the shared `run-gate`
action with a literal gate id, and `pnpm check:gate-manifest` verifies registration, workflow
ownership, path reachability, and routed device lanes. Raw shell text cannot declare ownership.

When adding a check, update the catalog and its executable model. When changing path ownership,
plant a path that would previously be misrouted and observe the selector or manifest fail before
fixing it. Keep workflow limitations such as manual-only or opaque owners in the gate declarations,
not duplicated here.

## Concurrency torture lane

The concurrency harness uses a deterministic scheduler for modeled lock grants and a separate real
request-scope serialization guard. A seed reproduces the scheduler trace and terminal invariant:

```sh
pnpm test:concurrency-torture
TORTURE_SEED=1234 pnpm test:concurrency-torture
```

Lock plans come from the production request-lock decisions; do not hand-author a parallel plan in the
harness. The modeled boundary is documented in its harness module, and every failure prints the
exact replay command.

## The `subprocess-stub` project

`SUBPROCESS_STUB_TESTS` enumerates the few files that spawn real subprocesses per case. They run in a
serialized Vitest project so host contention does not turn internal budgets into generic timeouts.
Membership requires naming the real spawned process; environment isolation alone is not a reason.
There is no unit-test retry layer—fix or remove flakes.

## Speed rules

- Unit tests do not wait production time. Prefer budget-derived cadence, assert that a caller passes
  the correct timeout to its tool seam, or use an existing clock seam.
- Wall clock is bounded by the slowest test file because Vitest parallelizes files. Splitting a
  monolith along source topology is a performance improvement as well as a readability improvement.
- The slow-test reporter enforces unit and integration budgets. Existing pins only shrink; a new pin
  requires measured justification.
- Test files above 1,000 lines are pinned to their merge-base size and may only shrink. Split the
  family before adding tests; never raise the pin.
- Keep Vitest isolation enabled and the pool on forks. Both alternatives were measured and did not
  improve the suite; importing the module under test rather than a platform barrel is the useful
  optimization.
