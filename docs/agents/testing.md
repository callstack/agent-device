# Testing Notes

Repository-specific testing traps you cannot learn from the test runner alone. Executable gate
ownership lives in `scripts/check-affected/` and `scripts/gate/`.

## Which gates a change needs

Three tiers:

1. While editing: a focused test or `pnpm check:quick`.
2. Before pushing: `pnpm check:affected --run`. It derives the relevant local gates and lists the
   checks that CI or a native toolchain owns.
3. For a broad refactor, or when the full deterministic gate is requested: `pnpm check`.

GitHub stays authoritative for provider integration, full coverage, native builds, device lanes, and
history-backed compatibility. To inspect the gate catalog or a plan:

```sh
pnpm check:affected
pnpm check:affected --json
pnpm gate --help
```

`check:affected --run` reports coverage obligations but never turns coverage instrumentation on. It
runs one capped `vitest related` command. Run the dedicated coverage scripts only to diagnose a red
CI result.

Two selection traps recur:

- A response that emits `platform` or `appleOs` needs provider integration and coverage evidence.
  Unit tests do not run the provider project, which is what catches internal `apple` leaking onto
  the wire.
- A workspace package manifest or TypeScript config can rewire all consumers, so the affected
  selector fails open to the full gate set on purpose.

Docs-only changes with no behavior impact need no runtime tests. Structural guidance gates still
need a planted violation that shows their failure direction.

## Platform and live-device policy

HarmonyOS has no provisioned CI emulator, physical device, DevEco image, or HDC installation. Unit,
provider, and coverage tests mock the typed HDC seam. Real validation is local hardware evidence per
`docs/agents/device-verification.md`. Do not add a CI lane that assumes a developer host.

Apple runner changes run `pnpm check:xctest-selection` and build the affected target. The source
`#if` guard is the XCTest lane classification — never maintain a second test-name list. Pure runner
decisions use the macOS host lane; iOS/XCTest semantics need a simulator lane.

Local host-lane XCTest runs hit two snags CI never does:

- System policy may refuse the unsigned bundle (`library load disallowed by system policy`, shown
  as `Early unexpected exit … crashed with signal kill`). Rebuild signed:
  `CODE_SIGN_IDENTITY="Apple Development"`, or pick an identity from
  `security find-identity -v -p codesigning`.
- The first run needs XCUITest automation permission for the host app.

Live smoke commands and their environment contracts live with their harnesses:

- web: `test/integration/smoke-web-platform.test.ts`
- iOS: `test/integration/smoke-ios-simulator.test.ts` and
  `test/integration/smoke-ios-simulator-coverage.test.ts`
- concurrency: `test/integration/nightly/concurrency-torture.test.ts`

Read the entry file before running a lane. Do not copy its environment matrix here — it changes.

## Shared test utilities

Before creating fixtures, look in `src/__tests__/test-utils/`. Import named builders from the module
that defines them (`session-factories.ts`, `device-fixtures.ts`, `store-factory.ts`). There is no
barrel on purpose: one barrel made every test evaluate every helper's transitive graph. Shared
`DeviceInfo`, session, snapshot, store, runtime-fact, and mocked-binary values belong in a sibling
fixture module, not in repeated test literals.

Use `mkdtempForTest` or `mkdtempForTestSync`. Global setup redirects `TMPDIR` for the whole run and
removes it after every worker exits — do not add per-test cleanup for those directories. An
interrupted run may leave a directory behind; the next run prunes it once the owner process and
every process using its `TMPDIR` are gone.

Mock the seam the subject consumes. A daemon handler that binds a runtime gets fake runtime facts
and facets, not a mock of generic dispatch. Generic dispatch mocks are migration debt — do not add
more. When an ADR 0019 command migrates, its tests move to the runtime seam in the same PR.

Vitest workers may signal only themselves and their direct children; `hermetic-signal-setup.ts`
rejects other process-table writes. Tests with fabricated PIDs mock `signalPidsBestEffort`,
`signalProcessGroupBestEffort`, or the tool-provider seam. A real child the test spawned may be
signalled directly.

## Regression evidence

A regression test must be seen failing without the production change: revert the implementation, run
the smallest owning test, record the failing count, restore. Apply the same proof to test relocation
and structural gates — plant a type error or violation and watch the intended gate find and name it.

A callback-based canary must observe the subject's semantic success, not just lifecycle completion.
Example: React Native Gesture Handler's
[`onFinalize`](https://docs.swmansion.com/react-native-gesture-handler/docs/fundamentals/callbacks-events/)
also fires when recognition fails or is interrupted — use an activation-dependent callback, or
assert the callback's success state before publishing a pass.

A device replay counts as automatic regression coverage only when an automatic PR or scheduled lane
selects and runs it. Name the owning lane and confirm the scenario ran on the exact PR head. A
replay in a manual or unselected tier is test material, not automatic evidence.

For structured classifiers, pair the positive case with the closest negative. When an error message
can be identical with and without a typed reason, the negative test must prove the message alone
cannot activate retry, fallback, or recovery.

Test through public interfaces where practical. Never add production exports or test-only dependency
injection just for a test; a missing seam must be a real product seam.

## Properties, fuzzing, and mutation

Pure parser and geometry changes extend the shared fast-check arbitraries and properties — not just
another example. Keep examples for a real past bug or a named decision. Reuse `PROPERTY_RUNS`
budgets so property files stay inside the unit slow-test gate.

Parser fuzz targets live in `scripts/fuzz/targets.ts`. Validation generators carry the invalid
outcome they planted, so silent acceptance and wrong error codes are failures. Cases run in a
worker process, so the two faults a case cannot report about itself — never returning, and killing
the process it runs in — are reported as `hang` and `crash` against the exact input rather than
taking the caller down with them. Promote a discovered case with the command the harness prints —
never hand-copy an unshrunk input.

Mutation is report-only and limited to the registry in `scripts/mutation/modules.ts`. It measures
whether tests distinguish changed decision logic. Do not infer redundancy from line coverage alone.

## Before editing a shared module

Run `pnpm depgraph affected` before touching a high-fan-in module:

```sh
pnpm depgraph affected packages/host-kit/src/command.ts
pnpm depgraph affected src/daemon/ref-frame.ts --json --limit 25
```

It reports value-edge dependents, affected gates, public commands whose handler chains reach the
module, live scenario owners, and interaction-guarantee cells; type-only and dynamic edges are
classified separately. Feed the plan into `pnpm check:affected --run` — do not keep a parallel gate
list in prose.

## Gate ownership

`CHECK_CATALOG` is the executable check registry. CI owns a check only through the shared `run-gate`
action with a literal gate id; `pnpm check:gate-manifest` verifies registration, workflow ownership,
path reachability, and routed device lanes. Raw shell text cannot declare ownership.

New check: update the catalog and its executable model. Changed path ownership: plant a path that
would previously be misrouted and watch the selector or manifest fail before fixing it. Workflow
limitations (manual-only, opaque owners) belong in the gate declarations, not here.

## Concurrency torture lane

The harness uses a deterministic scheduler for modeled lock grants plus a separate real
request-scope serialization guard. A seed reproduces the scheduler trace and terminal invariant:

```sh
pnpm test:concurrency-torture
TORTURE_SEED=1234 pnpm test:concurrency-torture
```

Lock plans come from the production request-lock decisions — never hand-author a parallel plan. The
modeled boundary is documented in the harness module, and every failure prints its exact replay
command.

## Real-subprocess-spawn tests

`SUBPROCESS_STUB_TESTS` enumerates the few files that spawn a real subprocess per case. They ran
serialized in their own Vitest project until #1823's kill criterion: now un-serialized in
`unit-core`'s default forks pool, reverted if a timeout-shaped failure appears within 20 consecutive
CI runs. Still excluded from the mutation lane either way. There is no unit-test retry layer — fix
or remove flakes.

## Speed rules

- Unit tests do not wait production time. Prefer budget-derived cadence, assert the caller passes
  the right timeout to its tool seam, or use an existing clock seam.
- Vitest parallelizes files, so wall clock is bounded by the slowest file. Splitting a monolith
  along source topology is a performance win, not just a readability win.
- The slow-test reporter enforces unit and integration budgets. Existing pins only shrink; a new
  pin needs measured justification.
- Test files over 1,000 lines may be no longer than at the merge-base with `origin/main`, and no
  new test file may cross that line. Split the family before adding tests; shrinking needs no
  gate edit.
- Keep isolation enabled and the pool on forks — both alternatives were measured and did not help.
  The useful optimization is importing the module under test, not a platform barrel.
- Local Vitest runs use a four-worker cap. Override it when a run needs a different host share:
  `AGENT_DEVICE_VITEST_MAX_WORKERS=<n>` (clamped to host CPUs, ignored in CI).
