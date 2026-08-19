# Testing Notes

## Which gates a change needs

Use three validation tiers:

1. **While editing:** run a focused test or `pnpm check:quick`.
2. **Before pushing:** run `pnpm check:affected --run`. It derives the relevant local gates from
   repository sources of truth and reports checks that need CI or a native toolchain.
3. **For broad refactors or an explicitly requested full local gate:** run `pnpm check`.

`pnpm check` is the deterministic core aggregate, not a local reproduction of every GitHub job.
Coverage, provider integration, history-backed compatibility, specialized toolchains, and live
device/browser lanes remain separate. GitHub CI stays authoritative.

## HarmonyOS hardware policy

GitHub-hosted CI has no DevEco Studio image, HDC installation, HarmonyOS emulator, or physical
device. HarmonyOS unit, provider, and coverage tests must mock `runHarmonyHdc` (or the lower-level
`runCmd`) and assert the typed HDC request, normalized response, capability gate, and failure
contract. They must never discover a host target or execute an `hdc` binary in CI.

Real HarmonyOS validation is a local hardware-evidence tier: run it only after the normal
deterministic gates, against a deliberately selected emulator or device, following
`docs/agents/device-verification.md`. Capture the command result and artifact/state evidence, then
close the session. Do not add a HarmonyOS CI job until it has an explicitly provisioned, isolated
device or emulator owner; a workflow that merely assumes a developer's HDC setup is not a CI gate.

The mapping it encodes, for when you need to run a gate directly or reason about coverage:

| Change | Gate |
| --- | --- |
| Any TypeScript | `pnpm typecheck` or `pnpm check:quick` |
| Expo test app (`examples/test-app/**/*.{ts,tsx,js,jsx,json}`) | Root lint and format plus `pnpm test-app:typecheck`; the affected selector runs lint/format locally and reports the CI-owned typecheck without installing the isolated Expo dependency graph |
| Daemon handler / shared module | `pnpm check:unit` |
| Tooling/config (`package.json`, `tsconfig*.json`, `.oxlintrc.json`, `.oxfmtrc.json`) | `pnpm check:tooling` |
| Platform/device response — anything emitting `platform`/`appleOs` on the wire, or shaping a daemon response | `pnpm test:integration:provider` **and** `pnpm test:coverage` |
| Cross-platform behavior | `pnpm test:integration` |
| Apple runner / Swift | Build the changed target with `pnpm build:xcuitest:<platform>`; use `pnpm build:xcuitest` only for shared iOS/macOS changes |
| Runner XCTest methods (`apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/**`) | `pnpm check:xctest-selection`, which prints how many methods each lane reaches — the counts move often enough that quoting one here would rot. Three lanes run the bundle, and a test's `#if` guard is its classification (the convention is written next to the flag in `RunnerTests.swift`): `#if AGENT_DEVICE_RUNNER_UNIT_TESTS` alone marks a pure runner decision, which the macOS host lane (`ci.yml` "Swift Runner Host XCTests", no simulator) runs on every PR; `… && os(iOS)` (or a nested `#if os(iOS)`) marks runner/XCTest semantics — launches the host app, routes through SpringBoard, asserts an iOS-only branch — which only the simulator lanes reach (`ios.yml`'s hand-written `-only-testing:` list on PRs, `xctest-nightly.yml` whole). The check evaluates the guards per platform, so it fails on a listed name no source declares or that lane's platform never compiles, on a declared test no lane reaches (a guard naming a platform nothing runs — the state two tvOS-only tests sat in), and on `RunnerTests/testCommand` — the runner's 24-hour server entry point, not a test — reaching any lane; `xcodebuild` treats an identifier matching nothing as an empty selection rather than an error, in both directions, so a renamed `-skip-testing:` entry would otherwise re-admit it silently. The host and nightly lanes assert their executed count equals the reach the check derives (`scripts/xctest-run-summary.ts`), so a build without the `-D` flag or a guard that compiles a file out reads as red rather than as a smaller green. To run the host set locally: build macOS with `AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS=1 pnpm build:xcuitest:macos`, then `xcodebuild test-without-building -xctestrun <derived>/Build/Products/*.xctestrun -destination 'platform=macOS,arch=arm64' -skip-testing:AgentDeviceRunnerUITests/RunnerTests/testCommand`. Two local-only snags CI does not hit. (1) If system policy refuses to load the unsigned bundle (`library load disallowed by system policy`, surfacing as `Early unexpected exit … crashed with signal kill`), rebuild it signed — but the incantation is machine-dependent, so try both: `CODE_SIGN_IDENTITY="Apple Development"` on a Mac with automatic signing configured, and the certificate's SHA-1 from `security find-identity -v -p codesigning` plus `CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=<team>` where the generic name resolves to "Mac Development" and fails. The wrong one of the two fails at signing, not silently. (2) The first run needs XCUITest automation permission for the host. GitHub's macOS runners need neither — they load the unsigned bundle as built |
| CLI help/guidance (`src/cli-schema/cli-help.ts`, `src/cli-schema/`) | `pnpm exec vitest run src/cli-schema src/cli/parser/__tests__ scripts/__tests__` — the `scripts/__tests__` gates enforce help-topic benchmark coverage and pin the bench's quoted CLI samples to the real renderers |
| Help benchmark cases (`scripts/help-conformance-*.mjs`) | `pnpm exec vitest run scripts/__tests__` (deterministic gates); model-backed: `pnpm bench:help-conformance` (paid LLM calls, local only) |
| `.ad` grammar (`src/replay/script.ts`, gesture arity, replay vars) | `pnpm exec vitest run --project unit-core test/replay-compat` — the frozen replay-compat corpus asserts which released script surfaces still parse; a flipped verdict is edited in `test/replay-compat/manifest.ts`, never in the script. Adding or re-pinning a corpus entry also runs `pnpm check:replay-compat`, which re-derives each entry from its release tag in git history |
| Daemon RPC wire surface (the declarations listed in `test/wire-compat/surface.ts` — JSON-RPC envelope, request/response/error/artifact/progress framing, `/health` payload, HTTP auth headers) | `pnpm exec vitest run --project unit-core test/wire-compat` holds the ledger to its source and prints the digest to paste; `pnpm check:daemon-wire-compat` compares it against the last released tag and requires a `DAEMON_RPC_PROTOCOL_VERSION` bump or a `compatibleChanges` ack for the drift. Read ADR 0006 to decide which; `test/wire-compat/README.md` walks both |
| Anything in `src/`, `test/` | `pnpm format` (`skills/` is Markdown-only guidance: oxfmt ignores `**/*.md`, and the affected-check selector classifies it docs-only) |
| Workspace package source (`packages/*/src/**`) | Root format/lint/typecheck plus layering (R11 package-boundaries); Vitest resolves affected tests through the module graph; package manifests/tsconfigs fail open to the full set |
| A decision kernel or its tests (`packages/kernel/src/errors.ts`, `src/daemon/ref-frame.ts`, `src/commands/interaction/runtime/settle.ts`, `src/utils/scroll-edge-state.ts`, `packages/selectors/src/`) | `pnpm mutation:run --modules <kernel>` (minutes; optional — the lane reports, it never gates, see the mutation section) |

Two traps worth naming:

- The platform/device-response row is the one agents miss. `pnpm check:unit` does **not** exercise the
  `provider-integration` project, and that project holds the apple-platform-output leak guard.
  Internal `apple` must never reach a command response — project through `publicPlatformString`.
- Fallow CI failures reproduce with `pnpm check:fallow --base origin/main`. Do not estimate
  complexity or dead-code impact by hand.
- `pnpm fallow:all` audits the entire repository and can report grandfathered baseline findings. Use
  it to inspect repository-wide debt, not as the changed-code gate.

Docs/skills-only and non-TS changes with no behavior impact need no tests. Test-only DI seam CI
failures are enforced by the workflow — do not add optional `typeof` DI params to production code to
satisfy a test.

## Shared test utilities

Before writing a new test, inspect `src/__tests__/test-utils/index.ts`:
`rg -n "export .*make|export .*DEVICE|withMocked" src/__tests__/test-utils`. Import through the
barrel and prefer named shared fixtures over inlining new `DeviceInfo`, `SessionState`, snapshot,
store, or mocked-binary objects. If a helper is missing, add it near the concept it serves and export
it through the barrel.

Need a scratch directory? Use `mkdtempForTest` / `mkdtempForTestSync` from
`src/__tests__/test-utils/tmp-dir.ts`, not `fs.mkdtemp(path.join(os.tmpdir(), ...))` directly. They're
plain wrappers — `os.tmpdir()` is already redirected for the whole unit-test run
(`scripts/vitest-tmpdir-global-setup.ts`) to one directory that gets removed in a single recursive rm
once every worker finishes, so raw calls would still be cleaned up automatically either way. The
helpers exist for discoverability, not correctness: don't add a per-test `afterEach`/`onTestFinished`
cleanup for a directory they created — that's the global teardown's job, and per-test cleanup that
already existed for other reasons should stay (it's the fallback global sweep that's new, not a
replacement for tests being tidy).

A run killed before its teardown (a tool timeout's SIGKILL, OOM, a cancelled job) leaves its
`/tmp/agent-device-test-run-<pid>-*` directory behind. The next run on the host prunes every such
directory that is genuinely abandoned (`pruneAbandonedRunDirectories`, called by both the Vitest
global setup and the `node --test` wrapper) and prints one `[tmpdir] pruned …` line, so
`check:tmpdir-leaks` after `test:unit` can only ever name the run that just finished. Abandoned
means nobody owns it **and nobody uses it**: the owner pid in the name is dead and no live process
has a `TMPDIR` inside it (read from `ps -E` on macOS, `/proc/<pid>/environ` on Linux). That second
half matters because a SIGKILL of the wrapper or Vitest main process leaves its `node --test` chain,
forked workers, and any daemon a test spawned running with that `TMPDIR` — they keep the directory
until the last of them exits. A concurrent run in another worktree is live by both tests. If the
check fails, the leak is this run's: a teardown that did not execute, not history.

Mock the seam the code under test consumes, not the widest one available. A daemon handler that
binds a device runtime is tested by handing it a fake `inspectFacts` / `bindDevice` (the fixture
shape in `src/daemon/__tests__/snapshot-runtime-fixture.ts`; the shared mocks in
`src/daemon/handlers/__tests__/session-command-harness.ts`; facts builders in
`src/__tests__/test-utils/runtime-operation-facts.ts`) — not by `vi.mock('.../core/dispatch.ts')`.
The generic dispatch mock is for tests *of* dispatch. Sixty-odd files still mock it from before
the runtime seam existed; retiring `dispatchCommand('snapshot')` surfaced them one failure at a
time. Do not add to that set, and when a command migrates (`docs/agents/adr-0019-unit.md`), its
tests move to the runtime seam in the same PR.

Signals are hermetic too. A vitest worker may signal only itself and its own **direct children**;
`src/__tests__/hermetic-signal-setup.ts` refuses every other process-table write and fails the
sending test by name. It covers both ways out of the process, because the runner-disposal family
uses both: `process.kill` (signal 0, the liveness probe, stays free) and a spawned
`kill`/`pkill`/`killall`, whose `-P` and `-f` forms reach processes the worker never spawned at all.
The refused pid is usually one the test made up (`child: { pid: 4242 }`), and on a real host that
number can belong to anyone — on CI it periodically belonged to a sibling fork, which died mid-file
with no test attributed ("Worker exited unexpectedly", #1824); a `pkill -f 'xcodebuild.*'` from a
unit test would find a developer's live runner.

If a test drives a real kill path against a fabricated pid, mock the seam where it already mocks the
liveness reads: `signalPidsBestEffort` / `signalProcessGroupBestEffort` in `src/utils/host-process.ts`
for direct writes, the exec or tool-provider seam for a spawned `pkill`. Killing a daemon or Metro
fixture the test itself spawned is fine — that pid is the worker's own. *Direct* is literal: a
grandchild started through a shell or `npx` wrapper is not tracked, so signal the direct child, or
its process group through the negative pid, rather than the grandchild's pid.

Keep tests behavioral. Do not assert shapes or cases TypeScript already proves.

A test added as a regression pin must be shown to fail without the change it pins — vacuity is the
default failure mode, not the exception, because the adversarial input you imagine is rarely the one
the old code was slow or wrong on (edge runs that the old regex handled in one pass; invariants the
old implementation already satisfied; entry points whose trimming defuses the exploit before it
reaches the flagged pattern). The proof is mechanical: revert the production change locally, watch
the test fail, note the failing number, restore. Same rule at other layers: after relocating tests,
prove the runner discovers them (file/test counts must move) and the typechecker reaches them (plant
a type error, watch it surface, remove it); after adding an ownership/structural gate, plant a
violation and watch it name the invariant. Quote the red run in the PR — a reviewer who cannot see
the red has to re-derive it.

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

Fast local feedback is a project value: the default developer loop should run the smallest relevant
gate set and return as quickly as correctness allows. Expensive informational measurements belong in
CI unless they are needed to diagnose a reported result. In particular, do not build a base checkout
or run package-size comparisons locally by default; use the authoritative Size workflow report during
review.

`pnpm check:affected --base <ref>` derives which local checks a diff needs, so
agents stop interpreting the testing matrix by hand. It is a **fail-open
advisory**: existing GitHub CI stays authoritative and required, and this only
narrows the *local* feedback loop.

```sh
pnpm check:affected --run     # default agent loop: plan + run
pnpm check:affected           # human-readable plan only
pnpm check:affected --json    # machine-readable plan only
```

The default base is `origin/main`; pass `--base <ref>` only when comparing against another ref.

The selection is derived from repository sources of truth rather than a
hand-maintained path map:

- **Affected Vitest tests** are delegated to `vitest related --run`, using
  Vitest's own project configuration and static module graph. The selector
  passes its complete changed-file set instead of reproducing Vitest globs or
  import ownership. Dynamic-import relationships remain outside Vitest's
  analysis; GitHub's authoritative full suites still cover that boundary.
- **Non-Vitest suites** retain explicit ownership. Root
  `test/integration/*.ts` files use the Node integration lane, and
  platform/build tools keep their native gates. Test-app source selects root
  lint and format plus its isolated typecheck; the typecheck is reported but
  left to CI by `--run` so a root checkout never installs Expo dependencies
  implicitly.
- **Always-on gates** (`lint`, `typecheck`, `layering`, `fallow`, `format`) fire
  for their input categories and are never silently skipped. Legacy
  `src/platforms/` source also selects provider-integration and coverage.
  `packages/platform-*` source selects the shared runtime-contract unit lane,
  provider-integration, and coverage so a package move cannot narrow its evidence.
- **Commands** are resolved from real `package.json` scripts, so a renamed
  script fails loudly instead of dropping a gate.
- A **small explicit build-ownership layer** covers the paths whose owning build
  cannot be derived: Swift runner, Android helpers, macOS helper, MCP metadata,
  the TS/Swift golden tables (`contracts/fixtures/`), and the public package
  surface (itself derived from `package.json` `exports`).
- **Device lanes** (`replay-ios`, `replay-ios-device`, `replay-macos`,
  `replay-android`, `replay-linux`, `web-smoke`) are owned by platform family
  (`scripts/check-affected/device-lanes.ts`): a path under a family-tagged tree
  (`packages/platform-<family>/`, `src/platforms/<family>/`, `android/`,
  `test/integration/replays/<leaf>/`, the lane-prefixed `test/integration/`
  smoke files) owns that family's lanes; untagged runtime surface owns every
  lane; unit tests under `src/` and `packages/*/src/` own none. The tags are
  directory-level only — `src/daemon/android-system-dialog.ts` is a naming
  convention, not a boundary, and stays shared. `ios.yml`'s `pull_request`
  `paths-ignore` is routed on this ownership and held to it both ways by the
  gate manifest (below); `push` to main runs every lane unconditionally.

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

Local coverage reuses the affected Vitest run as its LCOV producer and applies the changed-line
coverage gate to that report. It does not run the full instrumented suite; global coverage
thresholds and full unit/provider matrices remain authoritative in GitHub CI. When coverage is
selected, `vitest-related` is folded into this one affected coverage run, and full unit/provider
aggregates are not repeated locally.

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
- **guarantee-matrix rows** — the ADR 0011 cells (`packages/contracts/src/interaction-guarantees.ts`) whose
  `via` names the file, i.e. the guarantees your edit is the implementation of.

Lists are bounded (`--limit`, default 10) and always disclose what they hid; `--json` is
unbounded. The query is read-only, runs in well under a second, and adds no CI work — its model is
covered by `pnpm depgraph:test` (the existing `Layering Guard` job).

## Gate manifest: proving every check has a CI owner

Every gate above answers "is the code right?". None of them can answer "does CI still own this
check?" — and a check that silently loses its owner looks exactly like a green build. Two
suites had already stopped: `check:tmpdir-leaks` and `test:fixture-cache` were real package
scripts that no workflow ran, reachable only through the `check:unit` aggregate CI never
invokes.

`CHECK_CATALOG` (`scripts/check-affected/checks.ts`) is the registry of every check. CI ownership
is declared only by `uses: ./.github/actions/run-gate` with a literal `gate:` input; the action
then dispatches `pnpm gate <id>`. `pnpm check:gate-manifest` (`scripts/gate/`)
then asserts, against the real workflows:

- **owned** — every registered check is declared by some `pull_request`/`schedule` lane, compared
  per *unit* (a Vitest project, a `node --test` file) rather than per script name, so a lane
  running the whole suite covers one running part of it.
- **path coverage** — for each category the *real* selector emits over the tracked tree, every
  check it activates is run by a lane a PR touching only that path would actually start. This
  is #1420's class: a check can run somewhere and still be unreachable for the change that
  needs it.
- **registered** — every Vitest project and every suite script belongs to some check, so a new
  suite cannot arrive unowned.

Plus the wiring that keeps those honest: a structural gate id must name a registered check, the
canonical action is tested against its `pnpm gate` implementation, local composite actions are
followed transitively, and a job whose steps the loader cannot open fails closed.

What it deliberately does **not** do is infer execution from `run:` text or prove a conditional
step executes on every run. Raw shell can still run project code, but it cannot declare ownership;
`echo`, function bodies, command substitution, and `|| true` are therefore irrelevant to the
manifest. The check proves the smaller structural claim that every registered gate has an explicit
CI owner and every affected path can reach one.

The facts the manifest cannot derive live together in `scripts/gate/declarations.ts`: opaque
runners, reporting-only `test:*` scripts, unprovable and manual-only owners, and the **routed
lanes** — a `pull_request` lane whose `paths-ignore` list is asserted against the selector over
every tracked path, both ways: a path the selector fails open on or routes to one of the lane's
declared or sampled checks must start the lane, and a path it classifies as another family's
device-lane surface or as a unit test must not (`scripts/gate/routing.ts`). GitHub evaluates
`paths-ignore` before a runner is allocated, so this is routing with no job on the critical
path; the assertion is what keeps the hand-written glob list a derived artifact.

Two limits of the mechanism, both inherent to `paths-ignore` rather than to the assertion:
GitHub's path filters examine only the **first 300 changed files**, so a PR larger than that can
skip a routed lane on the strength of its first 300 paths alone (`push` to `main` has no filter
and is the backstop); and a lane may name a *sibling* workflow file exactly to say it does not
use it, but never a file in its own `uses:` closure — the composite actions its steps run, plus
its own definition — which the assertion refuses.

## Mutation report over decision kernels

Mutation score is the mechanical answer to "is this test load-bearing or decorative". A full-suite
sweep is unaffordable, so the scope is an enumerated list of pure decision kernels — modules where a
surviving mutant means a silently wrong agent-facing decision. The registry
(`scripts/mutation/modules.ts`) is the single source of truth: `stryker.config.json`'s `mutate` globs
are asserted against it, and PR-affected selection maps changed files through it. Modules that spawn
subprocesses or wait real time stay out by construction.

Mutation runs **report-only** on the seven decision kernels — a weekly full sweep plus a per-PR
affected sweep. It never gates: `scripts/mutation/run.ts` exits non-zero on a harness failure (a
missing report, an incomplete shard set, a bad argument) and never on a score. A low score is an
input for a human-authored test-strengthening PR, which is exactly how #1474 and #1475 were written.
The ratchet, baseline file and graduation rule this lane used to carry were deleted in #1457: in
three weeks nobody applied a baseline, so the gate half never operated while the report half was
paying.

```sh
pnpm mutation:test                      # harness self-test (fast, no Stryker)
pnpm mutation:run --modules selectors   # one module locally (~7 min for selectors)
pnpm mutation:check                     # score an existing .tmp/mutation/mutation.json
```

- **Weekly full sweep** (`.github/workflows/mutation-weekly.yml`) runs `shardMatrix()` from the
  registry: one job per module, except modules that declare a `shards` count and are sliced with
  `--shard i/n` (selectors is ~1,280 mutants, well past the 30-minute budget in one job). The report
  job merges the shard reports (`--report-dir`) into one per-kernel table — kernel, score, killed,
  survived, total, timeouts, plus the surviving mutants — and requires the full set
  (`--expect-shards`), so a dead shard fails the lane instead of publishing its module as 0%. The
  table lands in the job summary and the artifact.
- **PR lane** (`.github/workflows/mutation-affected.yml`) exists to prove the harness still runs end
  to end when the harness changes, so its matrix (`--list-affected`) is empty unless the diff touches
  the lane's own sources: the weekly sweep is the kernel report, and selecting on derived kernel
  ownership would run the full ten-shard sweep on 24 of the last 40 merged PRs for a report nobody
  gates on. The workflow triggers on exactly those sources (`LANE_TOOLING` in `run.ts`, asserted both
  ways by `workflow.test.ts`), so a PR that could only select `[]` never starts the job. Lane sources
  own no kernel, so a harness diff adds `LANE_CANARY` (`kernel-errors`, the registry's cheapest real
  sweep) to whatever kernels that same diff derives; otherwise it would select zero mutants and prove
  nothing. It reports the same table. `scripts/mutation/selection.test.ts` drives both halves of the
  rule through the real CLI against a throwaway worktree commit.
- **Provenance**: every report and lane envelope carries the Stryker version and the config content
  hash that produced it, so scores measured across a tool or config change are not read as
  test-strength change.
- **Test scope** is derived from Vitest's module graph (`vitest related` over the mutated files), the
  same delegation `pnpm check:affected` uses; see `scripts/mutation/test-scope.ts` for the three
  groups it drops and why dropping them cannot hide a surviving mutant.
- **Test ownership is derived, never listed** (`scripts/mutation/ownership.ts`): a test owns every
  kernel its imports reach, so `src/__tests__/daemon-error.test.ts` selects `kernel-errors` through
  `src/daemon.ts` without naming it. Reaching a kernel is a superset of killing its mutants, so the
  derivation over-selects on purpose; it applies to the modules a lane-tooling diff selects. Non-kernel
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

Two **validation targets** (#1781 B2) — `cli-validation` and `maestro-validation` — go further:
their cases are built from the real command surface (the CLI schema registry, the Maestro command
shapes) so they tokenize cleanly, and each case carries the outcome its generator planted
(`scripts/fuzz/validation-case.ts`). The judge then also fails a **silent acceptance** of an input
built to be invalid (the #1433 class, which a rejection-only invariant cannot see at all) and a
rejection carrying the **wrong `AppError.code`**.

Each CLI mutation class declares the parser layer that refuses it — `command-validation` (past the
argv scan, the reach these targets add) or `token-scan` (inside `parseFlagValue`, where the classic
`cli-args` target already reaches, capped under a quarter of the mutated budget). Rules whose whole
input space is a few strings are pinned seed cases rather than generated classes.

The declarations above are executable: `scripts/fuzz/validation-arbitraries-{cli,maestro}.test.ts`
replay fixed-seed samples against the real parsers and fail on a drifted generator, an unfired
class, a class refused in a layer it does not claim, a token-scan share over 25%, or a schema
surface derived at import (#1824). Read those files for the current guarantees rather than a list
here, which would only age.

Cases come from fast-check arbitraries (`scripts/fuzz/arbitraries.ts`, validation envelopes in
`scripts/fuzz/validation-arbitraries.ts`) built on the hazard vocabulary
shared with `src/__tests__/test-utils/property-arbitraries.ts`, so a hazard added for the property
suite reaches the fuzz lane too — and a counterexample is reported **shrunk**, with fast-check's seed
and replay path printed alongside the saved artifact.

A nightly discovery reaches the unit lane by promotion, not hand-editing: the printed
`promote:` command re-runs the downloaded artifact and appends it to
`scripts/fuzz/corpus/regressions.json`, which `scripts/fuzz/corpus-replay.test.ts` replays on every
PR — through the same worker watchdog, so a promoted hang case fails against its per-case budget
instead of wedging the unit job. `scripts/fuzz/harness.test.ts` covers the harness itself — an
untyped throw, an empty hint, a wedged worker, a silent acceptance, and a wrong error code must each be reported, startup time is never charged against the per-case budget, and
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
`SessionStore` and `LeaseRegistry`. **Modeled:** the enforced device claim (`InMemoryClaimRegistry`)
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
- `Replay Manual` (`.github/workflows/replays-manual.yml`) adds device lifecycle, system UI,
  recording/trace, and fixture replay scenarios without putting those slower operations on the
  pull-request merge gate. It is **`workflow_dispatch` only** since #1781 A1 — the suite failed
  every scheduled run from 2026-07-24 on — so `replay-ios`, `replay-ios-device`, and
  `replay-android` run when someone dispatches the workflow and at no other time. That gap is
  declared in `scripts/gate/declarations.ts` (`MANUAL_ONLY_OWNERS`) and printed by
  `pnpm check:gate-manifest` on every run. Each entry names the dispatch lane that still runs it,
  and the audit resolves that name: deleting the parked job, putting it back on a schedule, or
  removing its `run-gate` step fails the manifest instead of leaving the check listed as merely
  parked. `replay-android` is marked `opaque` because its gate sits inside the third-party
  emulator action's `script:`, which the loader does not read (#1429), so the job's existence is
  the whole attestation. Put the jobs back on a schedule once a dispatch run is green and delete
  their entries;
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
node --experimental-strip-types scripts/node-test-tmpdir.ts --test test/integration/smoke-ios-simulator-coverage.test.ts
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
node --experimental-strip-types scripts/node-test-tmpdir.ts --test test/integration/smoke-ios-simulator-coverage.test.ts test/integration/smoke-ios-simulator.test.ts
```

Use `AGENT_DEVICE_IOS_E2E_TIER=full` for the `Replay Manual` subset. Step history, coverage reports,
screenshots, recordings, traces, and failure context are written below
`test/artifacts/ios-simulator/` and uploaded by the existing shared artifact action. The six
Settings replays remain additive OS-chrome coverage and are not modified by this suite.

## The `subprocess-stub` project (serialized real spawners)

Three test files spawn a real subprocess per case, so under broad file parallelism the spawns get
starved past an internal budget and production returns a generic timeout instead of the asserted
error. They are **enumerated** in `SUBPROCESS_STUB_TESTS` (`vitest.config.ts`) — never a glob, which
would silently enroll every future file under a directory — and run in their own project with
`fileParallelism: false, maxWorkers: 1`, so only one of them spawns at a time. `unit-core` excludes
exactly that list, and both projects run inside one `vitest run`, so the serialized chain runs
alongside the main pool rather than after it (~0 added CI wall clock).

Issue #1823 owns the membership and the project's deletion test: if the three run un-serialized in
the default pool for 20 consecutive CI runs with no timeout-shaped failure, the project goes.
Adding a file needs the concrete spawn named at the entry; per-file `process.env` isolation is not a
reason, since `pool: forks` + `isolate: true` already give every project that.

**Removed 2026-08-18 (#1781 A4):** the enumerated single-retry policy (`contention-retry*`, #1419)
that reran runner-proven timeouts in these files once. It fired 0 times in 234 sampled Coverage-job
envelopes over the three weeks it existed, and refused every observed failure class, for ~1.45k LOC.
There is now no rerun layer in CI; a flaky unit test is fixed or deleted.

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
- **The test-file size ratchet** (`src/__tests__/test-file-size-ratchet.test.ts`) is the same
  shape for the other resource a giant test file consumes — a reader's context. Every test file
  over the 1,000-line tripwire is pinned at its exact length, R9-style: growth fails ("split it
  along the source module it mirrors"), shrinking fails until the pin is lowered in the same PR,
  a file that drops under the line leaves the list, and a new file may not cross it. The map is
  not the authority — git is: every file over the line is also held to its length at the
  merge-base with `origin/main` (renames followed), and no pin may exceed its file's base length,
  so growing a file and raising its pin, or adding a giant file with a pin, are red against
  history; a pin on a file at or under the line is red on its own, so the map cannot grow by
  pinning small files at their own length. Adding a test to a pinned file means moving that family out first — the failure names
  the file and the fix; never raise a pin. Needs `origin/main` fetched (CI's Coverage job does).
- **Isolation stays ON; pool stays forks — both measured.** `--no-isolate`: 205s wall vs 48s
  (module state — timers, memos, singletons — thrashes across files sharing a worker).
  `--pool=threads`: no change (50.4s). The ~100s aggregate import overhead is the price of
  isolation and is paid in parallel; reduce it per file by importing the module under test, not
  platform barrels.
