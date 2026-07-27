# Testing Notes

## Which gates a change needs

Default for code changes: `pnpm check:affected --base origin/main --run`. It derives the gate set
from repository sources of truth, so prefer it over interpreting the table below by hand. GitHub CI
stays authoritative.

The mapping it encodes, for when you need to run a gate directly or reason about coverage:

| Change | Gate |
| --- | --- |
| Any TypeScript | `pnpm typecheck` or `pnpm check:quick` |
| Daemon handler / shared module | `pnpm check:unit` |
| Tooling/config (`package.json`, `tsconfig*.json`, `.oxlintrc.json`, `.oxfmtrc.json`) | `pnpm check:tooling` |
| Platform/device response — anything emitting `platform`/`appleOs` on the wire, or shaping a daemon response | `pnpm test:integration:provider` **and** `pnpm test:coverage` |
| Cross-platform behavior | `pnpm test:integration` |
| iOS runner / Swift | `pnpm build:xcuitest` |
| CLI help/guidance (`src/cli/parser/cli-help.ts`, `src/cli-schema/`) | `pnpm exec vitest run src/cli/parser/__tests__ src/cli-schema/command-schema-guards.test.ts scripts/__tests__` — the `scripts/__tests__` gates enforce help-topic benchmark coverage and pin the bench's quoted CLI samples to the real renderers |
| Help benchmark cases (`scripts/help-conformance-*.mjs`) | `pnpm exec vitest run scripts/__tests__` (deterministic gates); model-backed: `pnpm bench:help-conformance` (paid LLM calls, local only) |
| SkillGym prompts/assertions | `pnpm test:skillgym:case <case-id>` (broad: `pnpm test:skillgym`, filter with `-- --tag fixture-smoke` or `-- --tag skill-guidance`) — agentic routing + local-help-consumption proof only; command-planning knowledge checks belong in the help bench |
| `.ad` grammar (`src/replay/script.ts`, gesture arity, replay vars) | `pnpm exec vitest run --project unit-core test/replay-compat` — the frozen replay-compat corpus asserts which released script surfaces still parse; a flipped verdict is edited in `test/replay-compat/manifest.ts`, never in the script. Adding or re-pinning a corpus entry also runs `pnpm check:replay-compat`, which re-derives each entry from its release tag in git history |
| Anything in `src/`, `test/`, `skills/` | `pnpm format` |
| A decision kernel or its tests (`src/kernel/errors.ts`, `src/daemon/ref-frame.ts`, `src/commands/interaction/runtime/settle.ts`, `src/utils/scroll-edge-state.ts`, `src/selectors/`) | `pnpm mutation:affected --base origin/main` (minutes; GitHub runs it per PR — see the mutation ratchet section) |

Two traps worth naming:

- The platform/device-response row is the one agents miss. `pnpm check:unit` does **not** exercise the
  `provider-integration` project, and that project holds the apple-platform-output leak guard.
  Internal `apple` must never reach a command response — project through `publicPlatformString`.
- Fallow CI failures reproduce with `pnpm check:fallow --base origin/main`. Do not estimate
  complexity or dead-code impact by hand.

Docs/skills-only and non-TS changes with no behavior impact need no tests. Test-only DI seam CI
failures are enforced by the workflow — do not add optional `typeof` DI params to production code to
satisfy a test.

## Shared test utilities

Before writing a new test, inspect `src/__tests__/test-utils/index.ts`:
`rg -n "export .*make|export .*DEVICE|withMocked" src/__tests__/test-utils`. Import through the
barrel and prefer named shared fixtures over inlining new `DeviceInfo`, `SessionState`, snapshot,
store, or mocked-binary objects. If a helper is missing, add it near the concept it serves and export
it through the barrel.

Keep tests behavioral. Do not assert shapes or cases TypeScript already proves.

Test through public interfaces where practical, and do not add unrelated production exports solely
to make a test easier — widening the public surface for a test is a product change, and the exports
outlive the test that motivated them. If a seam is genuinely missing, add it as a real one rather
than as a test affordance (the workflow separately forbids test-only `typeof` DI params).

## Properties over examples (pure parsers and geometry)

**Pure parser or geometry change → extend a property, not another example.** The parse/print and
geometry kernels (selectors, `@eN~sM` refs, `.ad` script lines, gesture planning, snapshot diff) are
covered by fast-check properties living in each owning module's test file. Their generators are
shared in `src/__tests__/test-utils/property-arbitraries.ts` and exported through the test-utils
barrel, so a new hazard (another quote shape, a new gesture kind, another `.ad` command) belongs in
the generator, where every property inherits it — not in a new hand-pinned case.

- Keep examples that document a specific decision or a real past bug; add the general guarantee as a
  property alongside them.
- Bound `numRuns` with the shared `PROPERTY_RUNS` / `PROPERTY_RUNS_SMALL` constants: properties run
  in `unit-core` under the same slow-test budget as everything else.
- A failing property prints the shrunk counterexample plus the seed and path to replay it; paste
  that seed into `fc.assert(..., { seed, path })` to re-run exactly that case.

## Affected-check selector (`pnpm check:affected`)

`pnpm check:affected --base <ref>` derives which local checks a diff needs, so
agents stop interpreting the testing matrix by hand. It is a **fail-open
advisory**: existing GitHub CI stays authoritative and required, and this only
narrows the *local* feedback loop.

```sh
pnpm check:affected --base origin/main --run     # default agent loop: plan + run
pnpm check:affected --base origin/main           # human-readable plan only
pnpm check:affected --base origin/main --json    # machine-readable plan only
```

The selection is derived from repository sources of truth rather than a
hand-maintained path map:

- **Affected Vitest tests** are delegated to `vitest related --run`, using
  Vitest's own project configuration and static module graph. The selector
  passes its complete changed-file set instead of reproducing Vitest globs or
  import ownership. Dynamic-import relationships remain outside Vitest's
  analysis; GitHub's authoritative full suites still cover that boundary.
- **Non-Vitest suites** retain explicit ownership. Root
  `test/integration/*.ts` files use the Node integration lane, SkillGym owns its
  harness and skill guidance, and platform/build tools keep their native gates.
- **Always-on gates** (`lint`, `typecheck`, `layering`, `fallow`, `format`) fire
  for their input categories and are never silently skipped. Platform source
  also selects the provider-integration and coverage gates required by the
  Testing Matrix.
- **Commands** are resolved from real `package.json` scripts, so a renamed
  script fails loudly instead of dropping a gate.
- A **small explicit build-ownership layer** covers the paths whose owning build
  cannot be derived: Swift runner, Android helpers, macOS helper, MCP metadata,
  and the public package surface (itself derived from `package.json` `exports`).
- **SkillGym ownership** covers skill guidance (`skills/`) and the SkillGym
  harness (`test/skillgym/`) — those changes select the (local-only) SkillGym
  suite, and their Markdown is treated as skill/harness input, not inert docs.

Changed-file discovery folds working-tree state into the local plan: in the
default local mode (`--head HEAD`) it unions the committed `base..HEAD` diff with
staged, unstaged, and untracked files, and disables rename detection so **both**
sides of a rename are classified (a moved file cannot look docs-only by its
destination alone).

Anything the selector cannot classify — unknown, ambiguous, workflow/tooling, or
a change to the selector's own sources — **fails open to the full check set**.
That includes this file: the Testing Matrix above is the prose the ownership
rules mirror, so `docs/agents/testing.md` is selector-owning
(`SELECTOR_OWNING_DOCS` in `scripts/check-affected/model.ts`) and outranks the
docs-only short-circuit its path would otherwise take. If the matrix moves
again, move that entry with it.
The plan documents the rule and changed path behind every selected check.

Model and catalog live under `scripts/check-affected/`; the derivation is guarded
by `pnpm check:affected:test` (the `Affected-check Selector` CI job).

## Before editing a shared module (`pnpm depgraph affected`)

Before you touch a module other code depends on, run:

```sh
pnpm depgraph affected src/utils/exec.ts          # bounded text, for an agent's context budget
pnpm depgraph affected src/daemon/ref-frame.ts --json --limit 25
```

The output tells you which gates to run and which live scenarios claim the behavior:

- **dependents** — reverse reachability over the layering gate's value-edge graph
  (`scripts/depgraph/model.ts`), split into direct and transitive, with a zone breakdown and the
  widest dependents by their own fan-in. Type-only and dynamic dependents are excluded: a
  type-only edge is free at runtime, and mixing them makes the count unactionable.
- **gates** — the check plan `scripts/check-affected/model.ts` selects for that dependent set. It
  is the same selector `pnpm check:affected` runs, so the two cannot disagree; run them with
  `pnpm check:affected --run`.
- **public commands whose handler chain reaches it** — the daemon route table
  (`src/daemon/request-handler-chain.ts`) closed over value *and* dynamic edges, because handlers
  are loaded through `import()`.
- **live scenario owners** — the iOS simulator coverage manifest's owning scenario for each of
  those commands, when that manifest is in the tree.
- **guarantee-matrix rows** — the ADR 0011 cells (`src/contracts/interaction-guarantees.ts`) whose
  `via` names the file, i.e. the guarantees your edit is the implementation of.

Lists are bounded (`--limit`, default 10) and always disclose what they hid; `--json` is
unbounded. The query is read-only, runs in well under a second, and adds no CI work — its model is
covered by `pnpm depgraph:test` (the existing `Layering Guard` job).

## Mutation ratchet over decision kernels

Mutation score is the mechanical answer to "is this test load-bearing or decorative". A full-suite
sweep is unaffordable, so the scope is an enumerated list of pure decision kernels — modules where a
surviving mutant means a silently wrong agent-facing decision. The registry
(`scripts/mutation/modules.ts`) is the single source of truth: `stryker.config.json`'s `mutate` globs
are asserted against it, and PR-affected selection maps changed files through it. Modules that spawn
subprocesses or wait real time stay out by construction.

```sh
pnpm mutation:test                      # ratchet self-test (fast, no Stryker)
pnpm mutation:run --modules selectors   # one module locally (~7 min for selectors)
pnpm mutation:check                     # ratchet an existing .tmp/mutation/mutation.json
pnpm mutation:baseline                  # full sweep, then record it (reviewed commit)
```

- **Weekly full sweep** (`.github/workflows/mutation-weekly.yml`) runs `shardMatrix()` from the
  registry: one job per module, except modules that declare a `shards` count and are sliced with
  `--shard i/n` (selectors is ~1,280 mutants, well past the 30-minute budget in one job). The ratchet
  merges the shard reports (`--report-dir`) for one verdict and requires the full set
  (`--expect-shards`), so a dead shard fails the lane instead of scoring its module as 0. Results are
  reported as a job summary plus an artifact. It never commits: the proposed baseline rides in the
  artifact, and applying it is a reviewed `pnpm mutation:baseline` commit, so a score cannot lower
  itself.
- **PR lane** (`.github/workflows/mutation-affected.yml`) derives the affected shard matrix
  (`--list-affected`) and merges the shards into one verdict. Before graduation the matrix is empty —
  a report nobody acts on is not worth the runner minutes — unless the diff touches the lane's own
  tooling, the one pre-graduation run that buys something: the gate has to be proven before it bites.
  Lane sources own no kernel, so that exception adds `LANE_CANARY` (`kernel-errors`, the registry's
  cheapest real sweep) to whatever the diff derives; otherwise it would select zero mutants and prove
  nothing. `scripts/mutation/selection.test.ts` drives both halves of the rule through the real CLI
  against a throwaway worktree commit.
- **Ratchet**: scores may only rise. `mutation-baselines/decision-kernels.json` records the
  high-water score per module plus the Stryker version and config content hash that produced it, so a
  score change caused by a tool/config change is reported as provenance drift, never as a
  test-strength regression.
- **Graduation, not a flag day**: gating is off until two consecutive comparable weekly sweeps pass
  (`stableRuns`/`requiredStableRuns` in the baseline); the PR job starts selecting modules — and
  failing on them — once the committed baseline says `gating: true`. A regression or provenance drift
  resets the counter.
- **Test scope** is derived from Vitest's module graph (`vitest related` over the mutated files), the
  same delegation `pnpm check:affected` uses; see `scripts/mutation/test-scope.ts` for the three
  groups it drops and why dropping them cannot hide a surviving mutant.
- **Test ownership is derived, never listed** (`scripts/mutation/ownership.ts`): a test owns every
  kernel its imports reach, so `src/__tests__/daemon-error.test.ts` selects `kernel-errors` through
  `src/daemon.ts` without naming it. A listed set of test files would silently omit exactly those
  indirect tests and rot as tests are added — weakening one would skip the ratchet. Reaching a kernel
  is a superset of killing its mutants, so the PR lane over-selects on purpose and shards the
  selected modules; a false positive costs runner minutes, a false negative costs the gate. Non-kernel
  *sources* are not owned: they can only move a score through those tests, and the weekly sweep
  re-measures the whole surface.
- **Lane envelope** (`scripts/lib/lane-envelope.ts`, issue #1430): every run writes
  `.tmp/mutation/lane-envelope.json` — schema version, commit, Stryker version, config hash, seed
  (`null`; the input is enumerated, not randomized), duration, result, stage, per-module scores — and
  both workflows upload it, so lane freshness and tool drift are readable without parsing logs. It is
  written on every exit path, including a crash before any mutant runs: an absent envelope would be
  indistinguishable from a lane that never ran.

## Parser fuzz lane

`pnpm fuzz:parsers` feeds generated hostile input to `parseArgs`, selector parsing,
`parseReplayScriptDetailed`, `batch --steps` JSON, and the Maestro compat parser, and enforces one
invariant: every rejection is a typed `AppError` whose normalized `hint` is non-empty, and no case
hangs (a worker-thread watchdog attributes a stall to the exact input).

```sh
pnpm fuzz:parsers                                  # all targets, 2,000 cases each, seed 1
pnpm fuzz:parsers --target selector --iterations 50000 --seed 7
pnpm fuzz:parsers --input-file .tmp/fuzz/<case>.json                  # repro a saved case
pnpm fuzz:parsers --input-file .tmp/fuzz/<case>.json --append-corpus  # …and pin it
pnpm fuzz:parsers --self-check                     # require the harness to still fail
```

The generating run is nightly (`Parser Fuzz Lane` in `.github/workflows/replays-nightly.yml`, seeded
by the run number). Every terminal path — pass, fail, `--self-check`, or a crash in the harness
itself — writes `<artifact-dir>/run-envelope.json` on the shared lane contract
(`scripts/lib/lane-envelope.ts`, #1430), with the lane's own facts under `data`: mode, per-target
cases/failures/durations, failures, repro commands, and `stage` (`error` marks a run that could not
complete itself, since the shared `result` is only `pass`/`fail`). `configHash` hashes the modules
that decide a case set, so "the same seed means different inputs now" is distinguishable from "the
parsers changed". The self-check and fuzz steps write to separate artifact subdirectories and both
run unconditionally; the step summary prints each envelope it finds and never fails on a missing
file.

Cases come from fast-check arbitraries (`scripts/fuzz/arbitraries.ts`) built on the hazard vocabulary
shared with `src/__tests__/test-utils/property-arbitraries.ts`, so a hazard added for the property
suite reaches the fuzz lane too — and a counterexample is reported **shrunk**, with fast-check's seed
and replay path printed alongside the saved artifact.

A nightly discovery reaches the unit lane by promotion, not hand-editing: the printed
`promote:` command re-runs the downloaded artifact and appends it to
`scripts/fuzz/corpus/regressions.json`, which `scripts/fuzz/corpus-replay.test.ts` replays on every
PR — through the same worker watchdog, so a promoted hang case fails against its per-case budget
instead of wedging the unit job. `scripts/fuzz/harness.test.ts` covers the harness itself — an
untyped throw, an empty hint, and a wedged worker must each be reported, startup time is never charged against the per-case budget, and
every mode writes an envelope — using the broken-on-purpose targets in
`scripts/fuzz/self-check-targets.ts` (also what `--self-check` runs in CI), so a regressed classifier
or watchdog cannot pass silently. Adding a parser to the lane means adding a target to
`scripts/fuzz/targets.ts` — nothing else.

## Live web smoke

The live web platform smoke runs the public built CLI against a local fixture page through the managed web backend:

```bash
AGENT_DEVICE_WEB_E2E=1 pnpm test:smoke:web
```

The test is skipped unless `AGENT_DEVICE_WEB_E2E=1` is set. The test runs `agent-device web setup` and `agent-device web doctor` with an isolated state directory before opening the fixture URL, so it verifies the public managed-backend setup path instead of relying on a global `agent-browser`. CI runs the lane on Node 24 because the managed backend requires Node >= 24. Failure artifacts, daemon state, and browser config are written under `test/artifacts/web/`.

## Concurrency torture lane

`test/integration/nightly/concurrency-torture.test.ts` (#1416, umbrella #1412 Track A) runs N concurrent
clients through randomized-but-**seeded** interleavings of open/mutate/close/takeover/kill against
the real `SessionStore` + `LeaseRegistry` (plus an in-memory device-claim model). After every run it
asserts: no leaked leases or claims, no cross-session state bleed, every lock released after owner
death, the session store stays consistent, and same-device critical sections never overlap (this
pins the router's same-device open serialization under 100+ interleavings).

A seed alone cannot reproduce Promise/event-loop interleavings, so **all** concurrency is routed
through a deterministic scheduler (`nightly/concurrency-torture/deterministic-scheduler.ts`) — an
instrumented dispatcher that is the sole source of ordering (which fiber steps next, and which waiter
wins a contended lock). A seed therefore fully determines execution order.

Each operation's lock plan is **not** hand-written: it is built exactly as the daemon builds it in
`createRequestExecutionScope` — gate on the production decision `shouldLockSessionExecution(command)`
(`src/daemon/daemon-command-registry.ts`), and only then resolve keys via the production router
primitive `resolveRequestExecutionLockKeys` (`src/daemon/request-binding.ts`), driven with a fake
device inventory through the production `withDeviceInventoryProvider` seam
(`nightly/concurrency-torture/bindings.ts`). Only the mutex *grant* is modeled by the scheduler, because
`withKeyedLock`'s native microtask hand-off cannot be reproduced from a seed. Consequently reverting
*either* production decision — exempting a command from execution locking, or dropping the `device:`
key — changes the derived plan and trips the overlap invariant, so the lane is genuinely coupled to
production lock resolution, not a duplicate of it. **Real:**
`SessionStore` and `LeaseRegistry`. **Modeled:** the advisory device claim (`InMemoryClaimRegistry`)
and process "kill" — the production claim is a filesystem/OS lock and real process death, both out of
scope for this scheduling lane and covered by their own unit tests. The full real-vs-modeled boundary
is documented at the top of `nightly/concurrency-torture/harness.ts`.

Because the seeded sweep *models* the mutex grant, a separate **real-scope guard**
(`nightly/concurrency-torture/real-scope-serialization.ts`) drives concurrent same-device opens through the
actual `createRequestExecutionScope().runLocked()` → `withRequestExecutionLocks` → `withKeyedLock`
and asserts the critical sections never overlap. This is intentionally not seeded (it exercises real
event-loop scheduling); its job is to fail if the production lock *application* path regresses, which
the modeled sweep alone could not catch.

```bash
pnpm test:concurrency-torture                    # default sweep (TORTURE_RUNS=128 seeds from 0)
TORTURE_SEED=1234 pnpm test:concurrency-torture  # replay ONE seed's exact interleaving (seed-replay flag)
TORTURE_RUNS=5000 TORTURE_SEED_START=0 pnpm test:concurrency-torture   # widen the sweep
```

Replay is exact: a given seed reproduces the whole scheduler trace (`traceSignature`), the terminal
invariant outcome, and the contention profile — equality on all three is asserted not just under
`TORTURE_SEED` but for **every seed in the normal sweep** (each seed is re-run and compared), so
non-determinism is caught on the ordinary CI/nightly path. The sweep also asserts real same-device
lock *contention* occurred (two clients parked on one `device:` lock), and a dedicated forced
two-client same-device test pins both clients to one device via `pinnedDevice` so they cannot land on
different devices, driving that contention deterministically.

Every failure prints the offending seed and the exact `TORTURE_SEED=<n> pnpm test:concurrency-torture`
replay command. The lane lives under `test/integration/nightly/`, deliberately **out** of the
`test:integration:node` glob so it is not an accidental PR-time run: the PR gate runs a fast default
sweep via an explicit `Run seeded concurrency torture lane` step in the Integration job, and the
`Concurrency Torture Nightly` workflow sweeps a much larger seed range on schedule. The nightly run
emits the shared scheduled-lane envelope (`scripts/lib/lane-envelope.ts`, #1430 — commit,
tool/`configHash` from the lane source hash, `seed` range, duration, result, with the seed sweep in
the typed `data` payload) via `TORTURE_ENVELOPE=<path>`, uploaded as the `concurrency-torture-envelope`
artifact. The
envelope is written once, after **all** lane tests settle, and reports `fail` if any of them (sweep,
replay self-check, or forced-contention guardrail) failed — a later-failing guardrail can never be
published as a passing envelope. Optional knobs: `TORTURE_CLIENTS`, `TORTURE_OPS`.

## Live iOS simulator coverage

The iOS lane combines three evidence layers instead of treating a catalog mention as E2E proof:

- pull requests run a short JSON-asserting fixture smoke against the real built CLI, daemon, XCTest
  runner, and simulator;
- the scheduled/manual nightly workflow adds device lifecycle, system UI, recording/trace, and
  fixture replay scenarios without putting those slower operations on the pull-request merge gate;
- command-contract, workflow-live, and capability-denial rows explicitly own functionality that
  requires remote sources, unavailable host permissions, or CI setup outside the app session.

`test/integration/ios-simulator-e2e/coverage-manifest.ts` is the executable ownership source. A new
public command fails the always-running Node contract until it has one primary owner and an
observable assertion. Live scenario claims are credited only after the scenario runs every claimed
command and records command-specific app/device/artifact evidence. Replay and test run inside the
same full harness, so its coverage report cannot turn green before their semantic fixture canaries
and JUnit output pass.

Command ownership guarantees at least one semantic path for every public command; it does not imply
that every optional collector or backend mode runs nightly. The complementary
`behavior-coverage.ts` matrix guards the cross-command mobile patterns from #320: cold deep-link
navigation, keyboard lifecycle, background resume, modal presentation, permission denial/reset/
acceptance, interrupted Home/app-switcher recovery, long-list rediscovery, and host-focus
preservation. Existing focused command contracts remain the evidence for additional expensive or
host-permission-dependent modes.

CI retrieves the Release fixture through `.github/actions/setup-fixture-app` with `install: false`;
the smoke then exercises the public `install` command. The artifact is keyed by the Expo native
fingerprint and repacked with current JavaScript, so screen and replay changes reuse the native
binary and do not need Metro. Both iOS workflows need `permissions.actions: read`; without it the
action deliberately falls back to an expensive inline native build. The pull-request consumer
polls a cold fingerprint while the producer workflow builds it, preventing two concurrent native
builds; hits proceed immediately. The pull-request lane also pins Finder as the frontmost host app
and, when the hosted runner can establish that canary, proves simulator automation does not steal
macOS focus.

Run the static contract and documented live skip locally:

```bash
node --test test/integration/smoke-ios-simulator-coverage.test.ts
```

Run a live tier after booting a simulator and obtaining a current Release `.app`:

```bash
pnpm build
pnpm clean:daemon
AGENT_DEVICE_IOS_E2E=1 \
AGENT_DEVICE_IOS_E2E_TIER=smoke \
AGENT_DEVICE_IOS_UDID=<simulator-udid> \
AGENT_DEVICE_FIXTURE_APP_PATH=<fixture.app> \
AGENT_DEVICE_FIXTURE_APP_ID=com.callstack.agentdevicelab \
AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE='agent-device-test-app:///automation?event={event}&payload={payload}' \
node --test test/integration/smoke-ios-simulator-coverage.test.ts test/integration/smoke-ios-simulator.test.ts
```

Use `AGENT_DEVICE_IOS_E2E_TIER=full` for the nightly subset. Step history, coverage reports,
screenshots, recordings, traces, and failure context are written below
`test/artifacts/ios-simulator/` and uploaded by the existing shared artifact action. The six
Settings replays remain additive OS-chrome coverage and are not modified by this suite.
## Speed rules (experiment-backed, 2026-07-04)

Measured on the full unit suite (340 files, 3,210 tests, 48s wall at ~7x parallelism):

- **Wall clock equals the slowest file.** The 44.6s android monolith bounded the whole 48s run
  (Amdahl at file granularity: vitest parallelizes per file). Splitting monolith test files is a
  wall-clock optimization, not just a navigation one — see the AGENTS.md test-topology mirror rule.
- **Unit tests must not wait real time.** The suite's worst tests slept through production budgets:
  10.8s to prove "times out" by waiting out the full constant, 8s emulator-boot polls at 1Hz, real
  retry backoffs. Conversion patterns, in preference order (tracking issue #1098):
  1. *Budget-derived cadence* (production-legit): poll intervals scale with the caller's timeout —
     this took `devices.test.ts` from 25.6s to 2.8s (9x) while making short-budget production calls
     more responsive.
  2. *Budget-wiring assertion*: don't re-prove the exec layer's timeout per call site; mock the tool
     layer and assert the right `timeoutMs` constant is passed. Exec-layer timeout semantics are
     proven once, in exec's own tests.
  3. *Fake clocks* where the code accepts an injected clock.

  Never add a test-only DI seam for this — the CI gate forbids it; patterns 1–2 are production
  improvements and test restructurings respectively.
- **The slow-test ratchet** (`scripts/vitest-slow-test-reporter.ts`) enforces this: unit budget
  2.5s, integration 15s, failure at 2x budget (the band between reports without failing — host
  load legitimately stretches borderline tests, and a flaky gate trains people to ignore it).
  The pin list only shrinks, or grows in the same PR with a justification.
- **Isolation stays ON; pool stays forks — both measured.** `--no-isolate`: 205s wall vs 48s
  (module state — timers, memos, singletons — thrashes across files sharing a worker).
  `--pool=threads`: no change (50.4s). The ~100s aggregate import overhead is the price of
  isolation and is paid in parallel; reduce it per file by importing the module under test, not
  platform barrels.
