# Audit: tooling, CI, root config — second pass (slice TOOL2)

## Coverage

Scope: the parts of `scripts/` and `.github/` that the first pass (`tooling-ci-config.md`) did not read as code. Findings from that report are not repeated; three findings below extend one of them and say so.

- Read fully:
  - All 11 shell scripts: `scripts/build-android-helper.sh`, `build-xcuitest-apple.sh`, `package-android-helper.sh`, `package-ios-simulator-runner.sh`, `teardown-ios-smoke.sh`, `wait-for-ios-simulator.sh`, `replays/android-manual.sh`, and the four under `.github/actions/setup-fixture-app/`.
  - The 11 workflows the first pass did not read: `perf-nightly`, `xctest-nightly`, `replays-manual`, `replays-nightly`, `test-app-build-cache`, `conformance-differential`, `conformance-regenerate`, `mutation-weekly`, `concurrency-torture-nightly`, `release-ios-runner`, `release-android-snapshot-helper`; plus the `select` job of `mutation-affected`.
  - All 9 composite actions other than `setup-node-pnpm`.
  - `scripts/layering/`: `check.ts`, `architecture-ownership.ts`, `daemon-modularity.ts`, `zone-policy.ts`, `root-module-zones.ts`, `retired-paths-policy.ts`, `retired-zone-policy.ts`, `executable-policies.ts`, `rule-ids.ts`, `ratchet-reference.ts`, `tracked-sources.ts`.
  - `scripts/mutation/run.ts`; `scripts/fuzz/{run,execute,options,corpus}.ts`; `scripts/coverage-changed/{model,run}.ts`; `scripts/coverage-crap/run.ts`; `scripts/depgraph/affected-run.ts`; `scripts/perf/{stats,measurement,config,cli,run,summary,metadata,compare,nightly-artifacts,compare-cli}.ts`; `scripts/capability-matrix/run.ts`; `scripts/maestro-conformance/{regenerate,build-manifest,format-generated-json}.mjs`, `pinned-upstream.json`, `jvm-harness/build.gradle.kts`.
- Skimmed (head, exports, or targeted sections): `scripts/layering/model.ts` (zones, ranks, back-edge logic), `daemon-layers.ts`, `contracts-implementation-policy.ts`, `application-lifecycle-policy.ts`, `substrate-domain-shape.ts`, `platform-package-policy.ts`; `scripts/capability-matrix/generate.ts`; `scripts/ios-snapshot-benchmark/{run.ts,types.ts,README.md}`; `scripts/perf/README.md`.
- Mechanical checks over the whole slice:
  - Every path literal in the non-test `.ts`/`.mjs` files of `layering`, `depgraph`, `mutation`, `coverage-*`, `capability-matrix`, `perf`, `fuzz`, `ios-snapshot-benchmark` was tested for existence.
  - `build-manifest.mjs` `NOTES` keys were cross-checked against the corpus (clean: no stale note, no flow without a note).
  - Grep for `TODO`/`FIXME`, error-text matching, and `allowFailure: true` call sites (no TODOs, no error-text matching).
- Not reached: about 30 `scripts/layering` policy bodies not named above (`session-state.ts`, `package-boundaries.ts`, `daemon-platform-boundary.ts`, `process-globals-policy.ts`, and others) and all layering tests; `scripts/mutation/{ownership,sharding,coverage-scope,score,modules}.ts`; `scripts/fuzz` arbitraries and targets; `scripts/coverage-crap/{model,stamp}.ts`; `scripts/depgraph/{model,build,structure-summary,affected}.ts`; `scripts/capability-matrix/{annotations,targets,collect,seams}.ts`; `scripts/perf/{suite,suite-harness,profile,report}.ts`; about 50 of the 57 `ios-snapshot-benchmark` files; the Kotlin JVM harness sources; the Maestro corpus and fixtures (generated data); every test file in these directories.
- Rough depth: shell scripts 100%, the unread workflows and actions 100%, about 30% of the remaining script bodies by lines. Nothing was executed except `git`, `grep`, and one read-only `node -e` cross-check.

## Findings

### TOOL2-1: `build-xcuitest-apple.sh` cleans the wrong directory for iOS, and deletes any override path that the daemon refuses to delete
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `scripts/build-xcuitest-apple.sh:100-118,126-128`.
  - Without an override on iOS, `resolve_clean_path` returns `$DERIVED_PATH/device`, that is `~/.agent-device/apple-runner/derived/device`. The same script builds into `$DERIVED_PATH` itself (`:148`). The daemon's keyed caches are `ios-simulator`, `ios-device`, `tvos-*`, `macos`, `visionos-*` (`packages/apple-runner/src/apple-runner-platform.ts:51-114`). Nothing writes `derived/device`, so `AGENT_DEVICE_IOS_CLEAN_DERIVED=1 pnpm build:xcuitest:ios` removes nothing.
  - With `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` set, the script runs `rm -rf "$DERIVED_PATH"` on any path. The daemon refuses that outside the project `.tmp/` (`packages/apple-runner/src/runner-cache.ts:295-313`), and `website/docs/docs/installation.md:130` says "the command fails instead of cleaning it". `scripts/clean-xcuitest-derived.mjs:58-102` is a third behaviour: in an override it removes only the known transient entries.
  - No test covers the script's clean branch (`git grep CLEAN_DERIVED -- scripts/__tests__` is empty).
- Fix: delete `resolve_clean_path` and the `rm -rf`; when the variable is truthy, call `node --experimental-strip-types scripts/clean-xcuitest-derived.mjs "$PLATFORM"`, and make that script apply `assertSafeDerivedCleanup`. Files: `scripts/build-xcuitest-apple.sh`, `scripts/clean-xcuitest-derived.mjs`, `scripts/__tests__/runner-isolation-diagnostics.test.ts` (it already drives the script with a stand-in toolchain).
- Effort: S
- Model: opus (touches which directory a user-facing env var deletes)
- Verify: a new case in `scripts/__tests__/runner-isolation-diagnostics.test.ts` that sets `AGENT_DEVICE_IOS_CLEAN_DERIVED=1` with an override outside `.tmp` and expects a non-zero exit with the path intact; `release-ios-runner.yml` dispatch stays green (its override is under `.tmp`).

### TOOL2-2: the nightly concurrency torture lane sweeps the same 5000 seeds every night
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `.github/workflows/concurrency-torture-nightly.yml:42-43` sets `TORTURE_SEED_START` to `'0'` and `TORTURE_RUNS` to `'5000'` on every scheduled run. `packages/daemon/test/nightly/concurrency-torture.test.ts:185-186` reads only those two values. The workflow header (`:5-7`) says "a seed fully determines execution order" and that the lane exists "to keep mining for ordering bugs" (`:11-12`). After the first green night on a commit range, seeds 0–4999 can only find regressions, never new interleavings. The parser fuzz lane solves the same problem with `FUZZ_SEED: github.run_number` (`replays-nightly.yml:74`).
- Fix: default `TORTURE_SEED_START` to `${{ github.run_number }}` multiplied by the run count (compute it in a step: `echo "TORTURE_SEED_START=$((GITHUB_RUN_NUMBER * 5000))" >> "$GITHUB_ENV"`), and keep the dispatch input as an override. The envelope already records the seed range.
- Effort: S
- Model: sonnet
- Verify: two consecutive dispatch runs upload envelopes with different, non-overlapping seed ranges.

### TOOL2-3: the full replay suites have had no automatic owner since 2026-07-24
- Category: unneeded
- Severity: medium     Confidence: high
- Evidence: `.github/workflows/replays-manual.yml:3-8` — "Both suites failed every scheduled run from 2026-07-24 on ... Move these jobs back into replays-nightly.yml once a dispatch run is green." `scripts/gate/declarations.ts:48-74` lists `replay-android`, `replay-ios`, and `replay-ios-device` as `MANUAL_ONLY_OWNERS`, described as "unowned by design and temporarily". The Android note says its full-tier scenarios "had never executed end to end". Today is 2026-11-10, so the parking is about 3.5 months old. Side effects of the parking:
  - `replays-nightly.yml` is named "Replay Nightly" but now runs only the parser fuzz lane.
  - The manual jobs still upload `replay-nightly-android-artifacts` / `replay-nightly-ios-artifacts` and use session names `nightly-android-target-drag` / `nightly-ios-target-drag` (`replays-manual.yml:67,141,175`, `scripts/replays/android-manual.sh:13`).
  - The Android job has `timeout-minutes: 15` (`:25`) for emulator boot, a CLI build, a full-tier E2E run, and a replay suite with two retries. I could not confirm that this is enough.
- Fix: this is a maintainer decision. Either repair and re-schedule the suites (then delete the three `MANUAL_ONLY_OWNERS` entries), or delete `replays-manual.yml`, `scripts/replays/android-manual.sh` and its test, the three catalog gates, and the replay scripts that only these lanes run. If the parser fuzz lane stays alone, rename `replays-nightly.yml` to match its content.
- Effort: L (repair) or M (delete)
- Model: opus (device behaviour, or a deletion that spans the gate catalog)
- Verify: `pnpm check:gate-manifest` prints no manual-only checks; one green scheduled run if repaired.

### TOOL2-4: a failed `git diff` makes the PR mutation lane select nothing and pass
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `scripts/mutation/run.ts:234-240` — `changedFiles` runs `git diff --name-only --merge-base <base> HEAD` with `allowFailure: true` and splits `stdout` without checking the exit code. On failure (unknown base ref, shallow clone without a merge base) it returns `[]`. `affectedMatrixFor([])` returns `[]` (`:671-687`). Then `--list-affected` prints `[]` (`:721-726`), so the `mutants` job is skipped by `if: needs.select.outputs.modules != '[]'` (`mutation-affected.yml:108`). In `--affected` mode, `sweep` prints "no decision-kernel modules affected" and writes a `pass` envelope (`:599-603`). The dispatch input `base` is free text (`mutation-affected.yml:43-46`), so a typo gives a green run that tested nothing. The file header (`:9-12`) states that a harness failure is the only non-zero exit; this is a harness failure that exits 0.
- Fix: drop `allowFailure`, or throw when `exitCode !== 0` with the stderr text. The existing `try/finally` in `main` then writes a `fail` envelope at stage `select`. File: `scripts/mutation/run.ts`; add a case to `scripts/mutation/selection.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm mutation:test`; `node --experimental-strip-types scripts/mutation/run.ts --list-affected --base origin/does-not-exist` exits non-zero.

### TOOL2-5: the Android SDK install step exists in six copies that disagree on error handling, and build-tools `36.0.0` is written nine times
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: the same `SDKMANAGER` lookup plus `yes | sdkmanager --licenses` plus `sdkmanager "platforms;android-36" "build-tools;..."` block is at `.github/actions/setup-android-replay-host/action.yml:63-77`, `.github/actions/setup-fixture-app/action.yml:67-90`, `.github/workflows/release-android-snapshot-helper.yml:44-56`, `.github/workflows/release.yml:87-97`, `.github/workflows/size.yml:49-59`, and `.github/workflows/test-app-build-cache.yml:168-182`. They handle the `yes` SIGPIPE three different ways:
  - `setup-android-replay-host:75` appends `|| true`, which also hides a real licence failure.
  - `setup-fixture-app:87-89` toggles `set +o pipefail` around the pipe.
  - The workflow copies rely on the default non-`pipefail` shell, with a comment in only one of them (`test-app-build-cache.yml:165-167`).
  The version literal `36.0.0` appears at `setup-android-replay-host:48`, `setup-fixture-app/action.yml:75,90`, `locate-android-apk.sh:6`, `repack-android-apk.sh:7`, `release-android-snapshot-helper.yml:32`, `release.yml:78`, `size.yml:31`, `test-app-build-cache.yml:181`. `scripts/build-android-helper.sh:61-62` says the version "decides the compiled bytecode and resources", and no test pins the copies together (`git grep 36.0.0 -- scripts test` is empty).
- Fix: add one composite action `setup-android-sdk` (input `build-tools`, default from one place; output `build-tools-dir`; exports `AGENT_DEVICE_ANDROID_BUILD_TOOLS`) with the `set +o pipefail` form. Call it from the six sites. Make the two `.sh` helpers read `AGENT_DEVICE_ANDROID_BUILD_TOOLS` instead of the literal.
- Effort: M
- Model: sonnet
- Verify: `pnpm check:gate-manifest`; `pnpm test:fixture-fallback`; one green run of `android.yml`, `size.yml`, and `test-app-build-cache.yml`.

### TOOL2-6: 43 retired-handler path entries and three regexes in the layering gate cannot fire without R81 firing first
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `scripts/layering/architecture-ownership.ts:54-124` lists `SESSION_LIFECYCLE_RETIRED_PATHS`, `INTERACTION_RETIRED_HANDLER_PATHS`, `SESSION_OBSERVABILITY_RETIRED_PATHS`, and `SNAPSHOT_EXECUTION_RETIRED_HANDLER_PATHS`. 41 of the 43 entries are under `packages/daemon/src/handlers/`. `scripts/layering/daemon-modularity.ts:61-120` checks them with regexes that match only that same folder. R81 (`scripts/layering/daemon-layers.ts`, the "not under a layer folder" branch) already rejects every production file whose first segment under `packages/daemon/src/` is not `core`, `resources`, `execution`, `sessions`, or `server`; `ls packages/daemon/src` shows exactly those five plus `index.ts`. A restored `handlers/x.ts` therefore fails R81 regardless of these lists. Only the two `sessions/<module>/index.ts` entries (`:55`, `:113`) can fire on their own. `checkRetiredSnapshotExecutionPaths` passes the never-matching regex `/$^/` (`daemon-modularity.ts:89`) to fit the shared helper's signature.
- Fix: delete the four lists and four check functions; keep the two `index.ts` paths as a `facades`-only rule, or drop them too because the facade check at `daemon-modularity.ts:252-265` already rejects imports of non-facade internals. Remove the matching cases from `scripts/layering/daemon-modularity.test.ts`. Files: `architecture-ownership.ts`, `daemon-modularity.ts`, `check.ts:497-503`.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:layering`; a scratch tracked file `packages/daemon/src/handlers/interaction.ts` still fails with an R81 violation.

### TOOL2-7: logical-module policies forbid imports into three directories that do not exist
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `scripts/layering/architecture-ownership.ts:147-148,158,168-170,179` — the `ad-replay`, `maestro`, `replay-test`, and `replay-port` policies list `src/providers/`, `src/compat/`, and `src/request/` in `forbiddenTargetRoots`. `ls src` shows none of the three. `resolveImportEdges` produces targets only for files in the scanned set, so these entries can never match. A package importing root `src/` at all is already rejected by R11 (`check.ts` header, "no relative path leaving its package dir"). Related: the `daemon-session-observability` entry (`:195-200`) omits `forbiddenTargetRoots`, which `LogicalModulePolicy` requires (`:15`); the first pass reported the resulting `satisfies` type error under TOOL-1. The only reader that would dereference it, `forbidsDaemonPackage` (`daemon-modularity.ts:288-290`), is unreachable for daemon files today, so there is no runtime crash.
- Fix: delete the seven dead entries; add `forbiddenTargetRoots: []` to `daemon-session-observability`.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:layering`.

### TOOL2-8: the changed-line coverage gate and the CRAP gate disagree on which report they trust and on what is instrumented
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: both gates read reports from one `pnpm test:coverage` run.
  - `scripts/coverage-crap/run.ts:186-188` refuses the Istanbul map unless `verifyCoverageStamp` proves that this checkout and commit wrote it, and takes the include and exclude lists from that stamp (`isInstrumentedPath(file.path, coverage)`, `:132`).
  - `scripts/coverage-changed/run.ts:64-75` reads `coverage/lcov.info` with no stamp check, so a stale report from an earlier commit gives a confident verdict.
  - `scripts/coverage-changed/model.ts:86` hard-codes the include roots as the regex `^(?:packages\/[^/]+\/)?src\/.*\.ts$`, a second copy of `vitest.config.ts:321`. The file header (`model.ts:6-11`) says the design avoids "a second copy of vitest's exclude globs"; the include globs are copied all the same.
  - A diff failure is a typed refusal in one gate (`coverage-crap/run.ts:181-185`) and an uncaught exception message in the other.
  CI is not affected because both gates follow the coverage run in one job. A local `pnpm check:coverage-changed` after switching branches is.
- Fix: call `verifyCoverageStamp` in `coverage-changed/run.ts` and replace `SOURCE_ROOT` with `isInstrumentedPath` over the stamp's `include`. Files: `scripts/coverage-changed/{run,model}.ts` and their tests.
- Effort: M
- Model: sonnet
- Verify: `pnpm check:coverage-changed:test`; `pnpm check:coverage-changed` on a checkout whose `coverage/` came from another commit exits 1 with the stamp reason.

### TOOL2-9: `test-app-build-cache.yml` carries conditions and a runner fallback that can never apply
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `.github/workflows/test-app-build-cache.yml:102` builds the matrix as `{ include: map(select(.build)) }`, so every matrix entry has `build: true`. Consequences:
  - `if: matrix.build` on eight steps (`:121,125,133,140,154,169,187,206,237`) is always true.
  - The `runsOn` fallback to ubuntu for a non-building iOS entry (`:91`) is never used.
  - `IOS_BUILD` is set to `false` for fork pull requests (`:73-77`), so no iOS entry exists on a fork. The repeated fork guards on "Build the iOS Release app" (`:155-156`), "Stage the binary" (`:207-209`), and "Publish" (`:238-239`, iOS half) are dead for iOS; only the Android half of the publish guard is live.
  - The job named "Resolve native fingerprint" also runs the `test-app-typecheck` and `test-app-security` gates (`:49-57`).
- Fix: remove the `build` field from the matrix entries and the `matrix.build` conditions; set `runsOn` as a constant per platform; keep one fork guard on the Android publish step. Rename the first job or move the two gates into their own job.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:gate-manifest`; one run on a same-repo PR and one on `main` publish the same artifact names as before.

### TOOL2-10: five workflows repeat the iOS runner build stanza and its pins, held together by comments
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: the block `setup-apple-runner-build` with `cache-key-prefix: ios-runner-prebuilt`, `cache-key-suffix: -ios-${{ env.IOS_RUNTIME_VERSION }}-arm64`, `gate: swift-runner-ios`, `xcuitest-platform: ios`, `xcuitest-destination: generic/platform=iOS Simulator` appears at `.github/actions/smoke-ios-run/action.yml:42-50`, `perf-nightly.yml:99-107`, `xctest-nightly.yml:76-84`, `replays-manual.yml:92-100`, and `conformance-differential.yml:67-75`. `IOS_RUNTIME_VERSION: '26.2'` and `AGENT_DEVICE_XCUITEST_ARCHS: 'arm64'` are set in five workflows. `xctest-nightly.yml:48-55,74-75` says "Must match apple.yml" and "Byte-identical inputs to apple.yml's step". No test asserts it (`git grep ios-runner-prebuilt -- scripts test` is empty). A one-sided edit causes a silent cache miss, which is a 20-minute build, or the arm64/x86_64 variant drift that the comment warns about.
- Fix: add a composite `setup-ios-runner` that owns the five inputs and the two env pins and optionally boots the simulator; or give those inputs defaults inside `setup-apple-runner-build` and assert equality in `scripts/__tests__/apple-ci-impact.test.ts`.
- Effort: M
- Model: sonnet
- Verify: the "Apple runner cache" job-summary key is identical across `apple.yml` and `xctest-nightly.yml` runs on one commit.

### TOOL2-11: one unreadable baseline artifact aborts the whole nightly perf comparison
- Category: broken
- Severity: low     Confidence: high
- Evidence: `scripts/perf/nightly-artifacts.ts:167-193` — `fetchSummary` returns `undefined` only when the artifact is missing; a downloaded `summary.json` goes through `parsePerfSummary`, which throws on any other schema string or shape (`scripts/perf/summary.ts:39-41`). `scripts/perf/compare-cli.ts:171-178` calls it inside the baseline `load` callback with no catch, and `:211-216` exits 1. The first bump of `PERF_SUMMARY_SCHEMA` therefore fails "Compare with earlier nights" (`perf-nightly.yml:136-148`) on both platforms every night until the old artifacts leave the 90-day retention window. `selectNightlyBaseline` already has the skip path (`load` returning `undefined`, `nightly-artifacts.ts:154-155`).
- Fix: in `fetchSummary`, catch the parse error for downloaded runs, log `run <id>: unreadable summary (<reason>)`, and return `undefined`. Keep the throw in `readLocalSummary`. Add a case to `scripts/perf/nightly-artifacts.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run scripts/perf/nightly-artifacts.test.ts`.

### TOOL2-12: the fuzz crash handler can crash before it writes the envelope it exists to write
- Category: broken
- Severity: low     Confidence: high
- Evidence: `scripts/fuzz/run.ts:180-186` — `reportCrash` calls `writeOutcomeEnvelope`, which calls `readCorpus().length` (`:170`). `readCorpus` throws on unreadable or malformed JSON (`scripts/fuzz/corpus.ts:27-31`). A corrupt `corpus/regressions.json` (or a bad `AGENT_DEVICE_FUZZ_CORPUS`) makes the first `readCorpus` throw inside `runMode`, then throw again inside the handler. The process dies on an unhandled rejection at `:219` with no `run-envelope.json`, which contradicts the header at `:5-6` ("Every terminal path ... writes one scheduled-lane envelope").
- Fix: compute `corpusEntries` with a guarded read (`null` on failure) inside `writeOutcomeEnvelope`.
- Effort: S
- Model: sonnet
- Verify: a new case in `scripts/fuzz/envelope.test.ts` that points `AGENT_DEVICE_FUZZ_CORPUS` at a file containing `{` and expects exit 1 plus an envelope with `result: "error"`.

### TOOL2-13: `pnpm depgraph affected` claims parity with `check:affected` but passes different inputs, and keeps a branch for a manifest that now exists
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `scripts/depgraph/affected-run.ts:8-9` says the gate list comes from "the same selector `pnpm check:affected` runs, so the two cannot disagree". It calls `selectChecks({ changedFiles })` (`:229`), while `scripts/check-affected/run.ts:283` also passes `packageEntryFiles`. This is a third call site for the problem the first pass reported as TOOL-2. Also:
  - `LIVE_COVERAGE_MANIFEST` (`:61`) exists (`test/integration/ios-simulator-e2e/coverage.ts`), so the `!present` branch and its text "is not in this tree (lands with the iOS simulator e2e manifest)" (`:195,198,278-281`) describe a finished migration.
  - `USAGE` (`:50`) and the not-found error (`:222-223`) say the graph covers "src/" only; it covers `packages/*/src` too (`scripts/layering/tracked-sources.ts:25-30`).
- Fix: export one `selectionInputFor(changedFiles)` from `scripts/check-affected/` and use it in all three callers (do this with TOOL-2). Make a missing manifest an error. Correct the two strings.
- Effort: S
- Model: sonnet
- Verify: `pnpm depgraph:test`; `pnpm depgraph affected src/sdk/index.ts` lists the `package` gate after TOOL-2 lands.

### TOOL2-14: `scripts/ios-snapshot-benchmark/` is a one-off evidence harness whose gate closed on 2026-09-21
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: 57 tracked files, about 7500 lines, including 18 test files that run in `unit-core` on every PR (`vitest.config.ts:219`). `scripts/ios-snapshot-benchmark/README.md:3` says the harness "owns the reproducible evidence contract for #2189, which supplies measurements to #2188". `docs/evidence/ios-snapshot-convergence-final-2026-09-21.md` ("What this closes") states that all of #2188's gate evidence "now exists at `7c434b5758`". References outside the directory are that document, three `bench:ios-snapshot*` package scripts, one layering test fixture string, and `scripts/__tests__/size-report-package.test.ts`. No workflow runs it. `run.ts:32-38` imports four types from `./types.ts` that live in `scripts/lib/bench-host.ts` (reported under TOOL-1); nobody noticed because nothing type-checks or runs it. I did not check the state of issues #2188 and #2189 on GitHub.
- Fix: ask the maintainer. If the convergence work is closed, keep `evidence/*.md` (the evidence document links to them) and delete the harness, its tests, the three package scripts, and the `vitest.config.ts` include line. If it is a standing benchmark, fix the type imports and add it to a lane.
- Effort: M
- Model: sonnet
- Verify: `pnpm check:fallow && pnpm test:unit && pnpm check:doc-links`.

### TOOL2-15: both asset-release workflows paste a dispatch input into shell, and one sets up Node it does not use
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `.github/workflows/release-ios-runner.yml:51` and `release-android-snapshot-helper.yml:67` run `TAG_NAME="${{ inputs.release_tag }}"` in a job with `contents: write`. The expression is expanded before the shell parses the line, so a value containing `"` or `$(...)` runs as code. Only users who can dispatch workflows can reach it, which is why this is low. The same value then goes unvalidated into `gh release upload` and the manifest JSON that `package-*.sh` writes with `printf`. Separately, `release-android-snapshot-helper.yml:39-42` runs `actions/setup-node`, but the job runs only `sdkmanager`, `javac`, `sh ./scripts/package-android-helper.sh` (which uses `sh`, `awk`, `shasum`, `zip`), and `gh`.
- Fix: pass the input through `env:` (`RELEASE_TAG: ${{ inputs.release_tag }}`) and validate it with `[[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]`. Delete the `Setup Node.js` step.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run test/ci/release-workflow.test.ts`; dispatch each workflow for an existing tag.

### TOOL2-16: `conformance-regenerate.yml` prints the repository commit as the Maestro version
- Category: broken
- Severity: low     Confidence: high
- Evidence: `.github/workflows/conformance-regenerate.yml:62` — `echo "Fixtures are byte-identical to a fresh regeneration from Maestro ${{ github.sha }}."` `github.sha` is this repository's commit. The pinned Maestro version and commit are in `scripts/maestro-conformance/pinned-upstream.json`.
- Fix: print `$(node -p "require('./scripts/maestro-conformance/pinned-upstream.json').version")`, as `conformance-differential.yml:114` does.
- Effort: S
- Model: sonnet
- Verify: read the step log of one dispatch run.

### TOOL2-17: `conformance-differential.yml` has two copies of its main step that differ by one argument
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `.github/workflows/conformance-differential.yml:137-163` — "Run differential" and "Run filtered differential" are the same `run-gate` call; the second adds `--only <id>`. `run-gate` drops empty argument lines (`.github/actions/run-gate/action.yml:26-30`), and `mutation-weekly.yml:76-77` already uses that for an optional flag (`${{ matrix.shard && '--shard' || '' }}`).
- Fix: keep one step with `${{ env.DIFFERENTIAL_ONLY != '' && '--only' || '' }}` and `${{ env.DIFFERENTIAL_ONLY }}` as the last two argument lines.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:gate-manifest`; dispatch once with and once without `only`.

### TOOL2-18: both `xctest-nightly` matrix legs build the runner on a cold cache, although a comment says only one pays
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence: `.github/workflows/xctest-nightly.yml:26-46` starts the iPhone and iPad legs in parallel. Each runs `setup-apple-runner-build` with the same key (`:76-84`). `setup-apple-runner-build/action.yml:98-103` saves the cache only after its own build. On a miss both legs build (about 20 minutes each on a 6-vCPU macOS runner) and one save loses. The comment at `:74-75` ("only the first one to run on a commit pays for the build") holds across workflows that run at different times, not across these two legs. The cost occurs only on nights when the Apple sources changed and `apple.yml` on `main` did not already fill the key; I did not measure how often that is.
- Fix: make the iPad leg `needs` a small build job, or set `max-parallel: 1` with the iPhone leg first.
- Effort: S
- Model: sonnet
- Verify: on a run with a changed `apple/runner/**` hash, only one leg's cache summary says "cache miss".

### TOOL2-19: `package-android-helper.sh` re-declares what `build-android-helper.sh` already reports
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `scripts/build-android-helper.sh:21-22,31,37` defines `MIN_SDK=23`, `TARGET_SDK=36`, and the two package names, and prints `package=<name>` at `:191`. `scripts/package-android-helper.sh:43-49` defines all four again and parses only `apk=` and `version_code=` from the build output (`:65-66`). The manifest fields `minSdk`, `targetSdk`, `packageName`, and `instrumentationRunner` (`:99-103`) come from the copies, so a change to the build script alone publishes a manifest that misdescribes the APK.
- Fix: print `min_sdk=` and `target_sdk=` from the build script and read them, with `package=`, in the packaging script; delete the second `case` and the two constants.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run scripts/__tests__/prepare-publish-assets.test.ts`; `pnpm build:android` on a host with the SDK and diff the manifest.

### TOOL2-20: small defects in the shell build scripts
- Category: broken
- Severity: low     Confidence: high
- Evidence:
  - `scripts/build-android-helper.sh:127,134,145` pass `$(find ... | sort)` unquoted to `javac` and `d8`, so a checkout path that contains a space splits into bad arguments. `PROJECT_DIR` is quoted everywhere else.
  - `scripts/build-android-helper.sh:176-179` checks for the signing keystore after compile, test, dex, link, and align; a missing keystore fails at the last step.
  - `scripts/package-ios-simulator-runner.sh:13` uses `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` as is, while `scripts/build-xcuitest-apple.sh:121-122` trims it "so a blank value means 'not set' everywhere". A whitespace-only value makes the build use the default path and the packager look in a path made of spaces.
  - `scripts/build-xcuitest-apple.sh:5,135,144,162,178,185,187` use repo-relative paths with no `cd`, unlike the Android scripts (`PROJECT_DIR`, `build-android-helper.sh:20`). `:134` and `:163` run the same `mkdir -p`.
  - `scripts/maestro-conformance/regenerate.mjs:113` passes `--args=--corpus ${CORPUS_DIR} --out ${outDir}`; Gradle splits `--args` on whitespace, so a repo or temp path with a space breaks regeneration.
- Fix: use `find ... -print0 | xargs -0` (or a `while read` loop with `set --`) for the source lists; move the keystore check next to the SDK checks; share the trim line; add `cd "$(dirname "$0")/.."` to the Apple script and drop the second `mkdir`; quote the two Gradle arguments.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run scripts/__tests__/runner-isolation-diagnostics.test.ts scripts/__tests__/prepare-publish-assets.test.ts`; `pnpm build:android` from a clone under a directory whose name contains a space.

### TOOL2-21: scheduled lanes share a cancel-in-progress group with manual dispatches on the same ref
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `xctest-nightly.yml:17-19`, `replays-nightly.yml:24-26`, `conformance-differential.yml:30-32`, `conformance-regenerate.yml:24-26`, `mutation-weekly.yml:24-26`, and `concurrency-torture-nightly.yml:32-34` all use `group: ci-${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true`. A `workflow_dispatch` on `main` while the scheduled run is active cancels the scheduled run, and the reverse. For the lanes that upload a freshness envelope, the cancelled night shows as a failed or missing lane. `perf-nightly.yml:56-58` sets `cancel-in-progress: false` for this reason. I did not find a past run where this happened.
- Fix: add `${{ github.event_name }}` to the group in the six workflows, or set `cancel-in-progress: false`.
- Effort: S
- Model: sonnet
- Verify: dispatch one of the workflows on `main` during its scheduled run; both finish.

### TOOL2-22: comment and structure drift in the layering tooling
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `scripts/layering/check.ts:17` says "This gate enforces five things, across four scopes"; the list that follows has 15 scopes, and `LAYERING_RULE_IDS` (`:435-472`) has 36 rules.
  - `scripts/layering/tracked-sources.ts:22-30` says "`src/**/*.ts` only matches NESTED files, so root-level `src/*.ts` ... needs its own pathspec". In a default git pathspec `*` matches `/`: `git ls-files -- 'src/*.ts' 'packages/*/src/*.ts'` returns the same 4176 files as all four pathspecs. Two of the four are redundant, and the comment states the reverse of the real behaviour.
  - `scripts/layering/ratchet-reference.ts:10-14` — the production gate imports `mergeBaseWithMain`, `readCommittedSources`, and `renamedSince` from `scripts/__tests__/committed-source-tree.ts`. Shared runtime code for two gates lives in a test directory, and R83/R84 hold product code to the opposite rule.
- Fix: replace the `check.ts` count with "the rules in `LAYERING_RULES`"; keep the two short pathspecs and correct the comment; move `committed-source-tree.ts` to `scripts/lib/`.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:layering`; `pnpm exec vitest run scripts/__tests__/eager-closure-budgets.test.ts`.
