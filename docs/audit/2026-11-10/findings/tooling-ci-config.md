# Audit: tooling, CI, root config (slice TOOL)

## Coverage

- Read fully: `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `vitest.config.ts`, `stryker.config.json`, `.fallowrc.json`, `fallow-production-exports.json`, `.jscpd-native.json`, `.oxfmtrc.json`, `server.json`, `glama.json`, `smithery.yaml`, `.gitignore`, `.github/renovate.json`, `patches/`, `scripts/check-affected/{checks,run}.ts`, `scripts/gate/{declarations,run,host-locked,shell,check,model}.ts`, `scripts/device-lane-impact.ts`, `scripts/apple-ci-impact.ts`, `scripts/sync-mcp-metadata.mjs`, `scripts/release-version.mjs`, `scripts/build-entries.ts`; workflows `ci`, `docs`, `deploy`, `size`, `agent-guidance`, `publish-mcp-registry`, `pr-cancel-on-close`, `release`, `linux`, `apple` (job body), `android` (job body), `mutation-affected` (jobs); actions `setup-node-pnpm`, `run-gate`.
- Skimmed / mechanically checked: `scripts/check-affected/model.ts` (about 60%), `tsdown.config.ts`, `oxlint.config.ts` (first 80 lines + cap table), `scripts/layering/*` (import topology, 3 files read), `sentinel.config.yaml`, `fallow-baselines/health.json` and `native-dupes-baseline.json` (every path checked for existence: all 53 health paths exist), every `package.json` script (file existence + repo-wide reference grep), every non-test file in `scripts/` and `tools/` (reference grep), every `scripts/**` test file (lane membership), all workflows (permissions, action pins, timeouts, triggers).
- Extra verification run: `tsc -p` over a scratch tsconfig that includes `scripts/**` and the root configs (read-only, output in scratchpad).
- Not reached: bodies of `scripts/maestro-conformance/**` (94 files), `scripts/ios-snapshot-benchmark/**` (57), `scripts/perf/**`, `scripts/fuzz/**`, `scripts/mutation/**` (only `run.ts` excerpt), `scripts/depgraph/**`, `scripts/coverage-*/**`, `scripts/capability-matrix/**`, most `scripts/layering` rule bodies, the shell build scripts, workflows `perf-nightly` (partial), `xctest-nightly`, `replays-*`, `test-app-build-cache`, `conformance-*`, `mutation-weekly`, `concurrency-torture-nightly`, `release-ios-runner`, `release-android-snapshot-helper`, and the composite actions other than the two above.
- Rough depth: ~25% of the slice by lines read as code; ~100% of the slice covered by the mechanical reference/staleness checks.

## Findings

### TOOL-1: 358 of 403 TypeScript files under `scripts/` are never type-checked; a direct `tsc` run reports ~190 errors
- Category: broken
- Severity: high     Confidence: high
- Evidence: `tsconfig.json:25-35` includes only `src`, `test`, and 7 named `scripts/` paths; `package.json` `typecheck` is `tsc -b tsconfig.typecheck.json examples/sdk/tsconfig.json`. `tsc -p tsconfig.json --listFilesOnly` lists 45 files under `scripts/`; `git ls-files 'scripts/**/*.ts'` (minus corpus) is 403. A scratch tsconfig that extends the root one and includes `scripts/**/*.ts`, `vitest.config.ts`, `vitest.mutation.config.ts`, `tsdown.config.ts`, `oxlint.config.ts` yields 211 `error TS` lines, 187 of them in repo files. Examples: `scripts/gate/host-locked.ts:27` (`string` passed where `CheckId` is required), `scripts/apple-ci-impact.ts:43` (`changedPaths` possibly null), `scripts/layering/architecture-ownership.ts:195` and `:206` (`satisfies LogicalModulePolicy[]` fails: missing `forbiddenTargetRoots`), `scripts/layering/package-boundaries.test.ts:198,200,929` (calls with the wrong arity: `checkPackageInternalSites` takes 4 args, `checkPackageBoundaries` takes 1), `scripts/ios-snapshot-benchmark/run.ts:32-38` (imports 4 types `types.ts` does not export), `scripts/depgraph/model.ts:133`, `scripts/integration-progress-model.ts` (44 implicit-any parameters), `oxlint.config.ts:128-300` (19 errors against `OxlintOverride`). These files run under `--experimental-strip-types`, so nothing ever reports the errors. The scripts that decide which CI lanes run (`check-affected`, `gate`, `device-lane-impact`) are in this set.
- Fix: add a `scripts/tsconfig.json` project (include `scripts/**/*.ts` and the root `*.config.ts`, exclude the Maestro corpus), reference it from `tsconfig.typecheck.json`, then fix the errors. Add `.d.mts` files (or `allowJs`/`checkJs: false` with declarations) for the `.mjs` modules that TS files import.
- Effort: L
- Model: opus (the errors span gate logic; some fixes change signatures)
- Verify: `pnpm typecheck` covers `scripts/gate/run.ts` (`tsc -p tsconfig.json --listFilesOnly | grep -c scripts/` equals the tracked count) and exits 0.

### TOOL-2: `own:public-surface` selection maps `package.json` exports to source paths that do not exist
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `scripts/check-affected/run.ts:111-116` and the identical copy at `scripts/gate/model.ts:221-224` derive entry sources as `./dist/src/X.js` -> `src/X.ts`. The real entries are `src/sdk/*.ts` and `src/ai-sdk/index.ts` (`scripts/build-entries.ts:1-16`). `src/index.ts`, `src/artifacts.ts`, `src/metro.ts`, `src/batch.ts`, `src/contracts.ts`, `src/selectors.ts`, `src/plugins.ts` do not exist; `src/io.ts` and `src/finders.ts` exist but are not the build entries. So `buildOwnership` (`scripts/check-affected/model.ts:571`) never selects the `package` gate for an edit to a real public entry such as `src/sdk/index.ts`. The unit test hides it with a hand-written list (`scripts/check-affected/model.test.ts:12`: `packageEntryFiles: ['src/index.ts', ...]`).
- Fix: derive the list from `buildEntries` in `scripts/build-entries.ts` (one exported helper used by both `run.ts` and `gate/model.ts`); change the test to assert that every derived path is tracked.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected:test`; `pnpm check:affected --json` with `src/sdk/index.ts` touched lists `package` with rule `own:public-surface`.

### TOOL-3: `.changeset/` holds 27 tracked files that no tool reads and nothing ever deletes
- Category: unneeded
- Severity: medium     Confidence: high
- Evidence: `git ls-files .changeset` = 27 `.md` files, no `config.json`; `@changesets/cli` is not in `package.json` or `pnpm-lock.yaml`; `git grep -n changeset -- . ':!.changeset'` matches only two unrelated test titles; `git log --diff-filter=D -- .changeset` is empty while commits still add files (`7fb6de2`, `27d87b1`, `c7df72a`, 2026-11-07). Release notes come from `gh release create --generate-notes` (`.github/workflows/release.yml` job `github-release`), and `.gitignore:59-60` says "Release notes are generated from PR titles". No contributor or agent doc mentions changesets.
- Fix: delete `.changeset/` and stop adding to it, or wire a consumer. Decide with the maintainer first, because someone is still writing these.
- Effort: S
- Model: sonnet
- Verify: `git ls-files .changeset | wc -l` is 0; release dry-run (`release.yml` on a PR) still passes.

### TOOL-4: `pnpm check` (the "full" local gate) skips four Vitest projects and several cheap CI gates
- Category: inconsistent
- Severity: medium     Confidence: medium
- Evidence: `scripts/check-affected/run.ts:292` runs only `check:tooling`, `check:fallow`, `check:unit`. `check:unit` -> `test:unit` = `vitest run --project unit-core --project fuzz-worker` (`package.json`), and `vitest.config.ts:253` excludes `packages/apple-runner/src/**/*.test.ts` from `unit-core`, so the 85 `apple-runner` test files, plus `provider-integration`, `interaction-contract`, and `output-economy`, do not run. `check:tooling` (`package.json`) is a hand-written chain that omits gates the catalog marks `localRunnable` and CI runs on every PR: `check:di-seams`, `check:agent-guidance`, `maestro:conformance`, `check:affected:test`, `mutation:test`, `check:replay-compat`, `check:daemon-wire-compat` (+ `:test`), `check:coverage-changed:test`, `check:coverage-crap:test`, `test:integration:progress:check`, `test:fixture-cache`. `CONTRIBUTING.md:219-224` documents provider integration as CI-only but describes `pnpm check` as covering "unit tests", which the apple-runner omission contradicts.
- Fix: make `--full` iterate `CHECK_CATALOG.filter(localRunnable)` (with `unit` replacing `vitest-related`) instead of three aggregate scripts, and add `--project apple-runner` to `test:unit` / `UNIT_TEST_PROJECTS`. Then delete `check:tooling`. Files: `scripts/check-affected/run.ts`, `scripts/lib/vitest-projects.ts`, `package.json`, `test/repo-guards/npm-package-scripts.test.ts`.
- Effort: M
- Model: opus (changes what the local gate runs and its host-lock time)
- Verify: `pnpm check:affected:test`; `pnpm check` output lists `di-seams` and the `apple-runner` project.

### TOOL-5: CI runs the provider-integration suite twice on every PR
- Category: inefficient
- Severity: medium     Confidence: medium
- Evidence: `.github/workflows/ci.yml:308` runs gate `unit-ci` = `vitest run --coverage --allowOnly=false --project=!fuzz-worker` (every project except `fuzz-worker`, so it includes `provider-integration`; the job comment at `ci.yml:281-282` says so). `.github/workflows/ci.yml:392-394` then runs gate `provider-integration` (`vitest run --project provider-integration`) again in the Integration job.
- Fix: drop the `provider-integration` step from the Integration job, or exclude that project from `test:coverage:ci`. Keep the gate-manifest ownership valid (the Coverage lane already covers the unit `vitest:provider-integration`).
- Effort: S
- Model: sonnet
- Verify: `pnpm check:gate-manifest`; compare Integration job duration before and after.

### TOOL-6: `tsdown.config.ts` keeps two chunk groups whose source paths no longer exist
- Category: unneeded
- Severity: medium     Confidence: high
- Evidence: `tsdown.config.ts:46-55` — `sdk-android-adb` matches `src/platforms/android/adb-executor.ts` and `sdk-app-inventory` matches `src/contracts/app-inventory.ts`. Neither directory exists (`ls src/platforms src/contracts` fails); the files are now `packages/platform-android/src/adb-executor.ts` and `packages/contracts/src/app-inventory.ts`. The present `dist/src` has no `sdk-android-adb*` or `sdk-app-inventory*` chunk. No test or script names those chunks.
- Fix: delete both groups, or repoint the regexes if a stable chunk is still wanted. File: `tsdown.config.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm build && pnpm check:bundle-owner-files && pnpm check:package`.

### TOOL-7: device-lane selection and `check:affected` disagree on rename handling
- Category: inconsistent
- Severity: medium     Confidence: medium
- Evidence: `scripts/check-affected/run.ts:74-90` uses `--no-renames` and explains why ("a moved file cannot look docs-only by its destination alone"). `scripts/device-lane-impact.ts:49` runs `git diff --name-only -z <base> HEAD` without `--no-renames`, so a rename reports only the destination path. A PR that moves a file out of a device-owned root (for example out of `packages/platform-apple/src/`) into an unowned or test path can skip the Apple, Android, Linux, or web-smoke lane that the source path owned.
- Fix: add `--no-renames` in `changedPathsFromGit`, or share one changed-file reader (`scripts/lib/repo-git.ts`). Files: `scripts/device-lane-impact.ts`, `scripts/__tests__/device-lane-impact.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run scripts/__tests__/device-lane-impact.test.ts scripts/__tests__/apple-ci-impact.test.ts` with a new rename case.

### TOOL-8: `scripts/lib/bench-host.test.ts` runs in no lane
- Category: broken
- Severity: low     Confidence: high
- Evidence: the file is a Vitest test (`import { test } from 'vitest'`), but it matches no `include` entry in `vitest.config.ts:129-253` and no `package.json` script path. It is the only `scripts/**` test file with no owner (checked all 193 against the config and script globs).
- Fix: add `'scripts/lib/bench-host.test.ts'` to the `unit-core` include list in `vitest.config.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run --project unit-core scripts/lib/bench-host.test.ts` reports the tests.

### TOOL-9: `test:maestro-compat` filters on a file that moved
- Category: broken
- Severity: low     Confidence: high
- Evidence: `package.json` `test:maestro-compat` = `vitest run --project unit-core packages/maestro src/compat/__tests__/replay-input.test.ts`; `src/compat/` does not exist, and the test is now `packages/ad-script/src/internal/__tests__/replay-input.test.ts`. Vitest filters are ORed substrings, so the script still passes while silently dropping that file. `CONTRIBUTING.md:205` and `:309` advertise the script as the compatibility entry point.
- Fix: replace the stale filter with `packages/ad-script/src/internal/__tests__/replay-input.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm test:maestro-compat` output lists `replay-input.test.ts`.

### TOOL-10: `.fallowrc.json` exempts two exports that no longer exist
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `.fallowrc.json:370` (`matchAgentBrowserChromeProcess`) and `:372` (`summarizeManagedAgentBrowserProcesses`) under `packages/platform-web/src/agent-browser-lifecycle.ts`; `git grep` finds both names only in `.fallowrc.json`. Every other `ignoreExports` symbol, `entry`, `dynamicallyLoaded`, `ignorePatterns`, and `overrides` glob was checked and still resolves.
- Fix: delete the two names from the `exports` list.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:fallow && pnpm check:production-exports`.

### TOOL-11: `scripts/help-conformance-sample-outputs.d.mts` is out of date with its `.mjs`
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `scripts/__tests__/help-conformance-sample-producers.ts:6-12` imports `BROWSERSTACK_CONNECT_SAMPLE`, `DEVICE_CLAIM_IN_USE_SAMPLE`, `FOREGROUND_SNAPSHOT_FAILURE_SAMPLE`, `MERGED_CARD_ACTIONS_SAMPLE`, `OFFSCREEN_TARGET_SNAPSHOT_SAMPLE`; `tsc` reports TS2305/TS2724 for each because the hand-written declaration file does not declare them. `.fallowrc.json` `ignorePatterns` exempts the `.d.mts` files, so no gate sees the drift.
- Fix: regenerate or hand-update the `.d.mts`; better, convert `help-conformance-sample-outputs.mjs` to `.ts` and delete the declaration file. Covered automatically once TOOL-1 lands.
- Effort: S
- Model: sonnet
- Verify: the scratch `tsc` run from TOOL-1 shows no error in `help-conformance-sample-producers.ts`.

### TOOL-12: three device lanes install all dependencies before they decide to skip
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence: `.github/workflows/apple.yml` (Setup toolchain, then "Select iOS/macOS smoke tests"), `.github/workflows/android.yml` and `.github/workflows/linux.yml` (same order). The selector imports `scripts/layering/platform-package-policy.ts:19` -> `@agent-device/kernel/device`, so it needs workspace links, which forces `pnpm install --frozen-lockfile` on a 6-vCPU macOS runner even when both Apple phases are skipped.
- Fix: move the selection into a small first job on ubuntu (as `mutation-affected.yml` does with `select`) and gate the device job with `if:`; or make `device-lanes.ts` import the family list from a dependency-free module. Files: the three workflows, `scripts/gate/workflows.ts` tests if lane labels change.
- Effort: M
- Model: opus (touches gate-manifest lane derivation)
- Verify: `pnpm check:gate-manifest`; a test-only PR shows the macOS job skipped without a runner start.

### TOOL-13: `docs.yml` uses two jobs with identical setup for five gates
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `.github/workflows/docs.yml` jobs `check` and `command-docs` each do checkout + `setup-node-pnpm` (full install); `command-docs` then runs one Vitest file. The `ci.yml:120-123` comment states that merging jobs changes nothing the gate manifest asserts.
- Fix: move the `command-docs` step into the `check` job and delete the second job.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:gate-manifest`.

### TOOL-14: `release.yml` job `mark-released` installs all dependencies to run two builtin-only scripts
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `.github/workflows/release.yml` (`mark-released`: `uses: ./.github/actions/setup-node-pnpm` with defaults); the job runs `node scripts/release-version.mjs advance`, which imports only `node:` modules (`scripts/release-version.mjs:1-4`) and spawns `release-workspace.mjs sync` and `sync-mcp-metadata.mjs`, which also import only `node:` modules.
- Fix: pass `install-deps: 'false'` (as `deploy.yml` does).
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run test/ci/release-workflow.test.ts`; release dry-run.

### TOOL-15: `deploy.yml` has no timeout, no concurrency group, and an unneeded `pages: write`
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `.github/workflows/deploy.yml:27-31` — the job has no `timeout-minutes` (every other workflow sets one) although it polls for 20 minutes; there is no `concurrency`, so two pushes can race two deploys to `gh-pages`; `pages: write` is granted but the job only pushes a branch through `JamesIves/github-pages-deploy-action`, which needs `contents: write` only.
- Fix: add `timeout-minutes: 30`, `concurrency: { group: deploy-docs-redirects, cancel-in-progress: false }`, and remove `pages: write`.
- Effort: S
- Model: sonnet
- Verify: `workflow_dispatch` run on main succeeds.

### TOOL-16: `@types/json-schema` is an unused root devDependency
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: `package.json:352`; `git grep -nE "from 'json-schema'|JSONSchema[467]?\b"` finds only a comment at `src/ai-sdk/index.ts:65`, which explains that the type is derived from `jsonSchema()` to avoid a dependency. The package remains in the lockfile as a transitive dependency of another package (`pnpm-lock.yaml:6393`).
- Fix: remove the entry and run `pnpm install`.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck && pnpm build`.

### TOOL-17: Stryker HTML report is configured and uploaded but never produced
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `stryker.config.json:15` sets `"reporters": ["progress", "json"]`; `:19-21` configures `htmlReporter`; `.github/workflows/mutation-affected.yml:150` uploads `.tmp/mutation/mutation.html`. `scripts/mutation/run.ts:331-339` only ever overrides reporters with `scope-coverage`.
- Fix: delete `htmlReporter` and the upload path, or add `"html"` to `reporters`. Note that any `stryker.config.json` edit changes the config hash the lane envelope carries (see the `_comment` field).
- Effort: S
- Model: sonnet
- Verify: `pnpm mutation:test`.

### TOOL-18: `smithery.yaml` is named as a sync target but nothing reads or checks it
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `scripts/sync-mcp-metadata.mjs:1-60` reads and writes only `package.json` and `server.json`. `.github/workflows/ci.yml:246` says "server.json/smithery.yaml drift", and `scripts/check-affected/model.ts:512` makes `smithery.yaml` an owner of the `mcp-metadata` gate, which cannot detect any change to it. The file is one line (`runtime: 'typescript'`) and ships in the npm package (`package.json:249`). The Smithery `typescript` runtime expects a server module export, which this CLI package does not declare; I could not confirm that the listing works.
- Fix: decide whether the Smithery listing is live. If not, delete `smithery.yaml`, its `files` entry, and the ownership rule. If yes, add a real check. Also correct the `ci.yml` comment.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:mcp-metadata && pnpm check:package && pnpm check:affected:test`.

### TOOL-19: `test:coverage` and `test:coverage:ci` are the same command
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `package.json` — both are `vitest run --coverage --allowOnly=false --project=!fuzz-worker && pnpm test:fuzz-worker`. Both names are referenced (`scripts/gate/declarations.ts`, `scripts/coverage-crap/model.ts`, `CONTRIBUTING.md`).
- Fix: keep one script and update the references (`scripts/check-affected/checks.ts:122`, `scripts/gate/*`, `scripts/coverage-*/`, `vitest.config.ts` comments, `CONTRIBUTING.md`).
- Effort: S
- Model: sonnet
- Verify: `pnpm check:gate-manifest:test && pnpm check:coverage-crap:test && pnpm check:gate-manifest`.

### TOOL-20: six `package.json` scripts have no caller and no documentation
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: repo-wide grep (excluding `package.json` and the lockfile) returns zero references for `bench:help-conformance`, `build:android-ime-helper`, `build:xcuitest:ios:clean`, `build:xcuitest:tvos:clean`, `build:xcuitest:visionos:clean`, and `package:apple-runner:npm` (`scripts/prepare-publish-assets.mjs:23` spawns the `.mjs` file directly). They may be manual conveniences; none is in `CONTRIBUTING.md` or `docs/`.
- Fix: delete the ones the maintainer does not use by hand.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run test/repo-guards/npm-package-scripts.test.ts && pnpm check:gate-manifest`.

### TOOL-21: `scripts/check-provider-plugin.mjs` is a pre-push check that no lane and no doc invokes
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: the header (`scripts/check-provider-plugin.mjs:1-3`) says "Manual pre-push check ... no CI lane runs it". The only reference in the repo is the Fallow `entry` at `.fallowrc.json:6`; the three `packages/provider-*/test/package-smoke.mjs` fixtures exist only for it and are also Fallow entries. A check that only its own header describes will go stale without anyone noticing.
- Fix: register it as a gate (it needs `pnpm build`, so it fits the "Lint, Typecheck & Package" job after "Build CLI"), or delete it with the three fixtures and four Fallow entries.
- Effort: M
- Model: sonnet
- Verify: `pnpm build && node scripts/check-provider-plugin.mjs packages/provider-testmu`; `pnpm check:gate-manifest`.

### TOOL-22: platform coverage-manifest tests run in the Integration job and again in each device lane
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `test:integration:node` globs `test/integration/*.test.ts` (`package.json`), which includes `smoke-macos-coverage.test.ts`, `smoke-android-emulator-coverage.test.ts`, `smoke-ios-simulator-coverage.test.ts`. The same files run again at `.github/actions/smoke-macos/action.yml:9` (gate `macos-coverage`), `.github/workflows/android.yml:74`, and `.github/actions/smoke-ios-run/action.yml:125`. The `macos-coverage` gate therefore checks an invariant the `integration-node` gate already owns.
- Fix: remove the three device-lane invocations and the `macos-coverage` catalog entry, or exclude `smoke-*-coverage` from the node glob. Files: `scripts/check-affected/{checks,model}.ts`, the two actions, `android.yml`.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:gate-manifest && pnpm check:affected:test`.

### TOOL-23: one `oxlint.config.ts` line-cap entry is obsolete
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: `oxlint.config.ts` `LEGACY_FILE_LINE_CAPS` lists `packages/host-kit/src/internal/exec.ts: 1032`; the file has 998 lines, below `MAX_FILE_LINES = 1000`. The table comment says "remove entries when files fit MAX_FILE_LINES". Six other caps have 2-12 lines of slack (`runner-session.test.ts`, `cli-client-commands.test.ts`, `remote-connection.test.ts`, `daemon-client-lifecycle.test.ts`, `daemon-client/index.test.ts`, `command-tools.test.ts`).
- Fix: delete the `exec.ts` entry; lower the six caps to the current counts.
- Effort: S
- Model: sonnet
- Verify: `pnpm lint`.

### TOOL-24: stale coverage exclusion and stale workflow names in tooling comments
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `vitest.config.ts:339` excludes `src/core/interactor-types.ts`, which moved to `packages/contracts/src/interactor-types.ts` (and `**/*-types.ts` at `:334` already covers both it and `src/client/client-types.ts` at `:338`). `scripts/check-affected/checks.ts:152` and `scripts/check-affected/device-lanes.ts:7,26` refer to `ios.yml`; the workflow is `apple.yml`. `.github/workflows/ci.yml:219-221` says the gate manifest validates "CHECK_CATALOG's `ciJobs`", a field the catalog no longer has (`scripts/check-affected/checks.ts:8-10` says jobs are derived).
- Fix: delete the two redundant exclude lines; correct the three comments.
- Effort: S
- Model: sonnet
- Verify: `pnpm test:coverage` thresholds unchanged; `pnpm check:affected:test`.

### TOOL-25: workflow step names that do not describe the step
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `.github/workflows/ci.yml:376-377` "Run integration tests" runs `pnpm clean:daemon`; `ci.yml:421-426` "Run live web smoke" runs `pnpm clean:daemon`; `.github/workflows/linux.yml` "Run Linux replay smoke test" runs `pnpm clean:daemon`. A red or slow step with that name points the reader at the wrong command.
- Fix: rename the three steps to "Reset daemon before ..." (the name `linux.yml` already uses for the fourth occurrence).
- Effort: S
- Model: sonnet
- Verify: `pnpm check:gate-manifest:test` (workflow parsing tests).

### TOOL-26: several pinned actions are one or more majors behind and run on the Node 20 action runtime
- Category: broken
- Severity: low     Confidence: low
- Evidence: `actions/upload-artifact@...# v4.6.2` (21 uses), `actions/download-artifact@...# v4.3.0` (3), `actions/cache/{restore,save}@...# v4.2.3` (10), `actions/setup-java@...# v4` (1), `pnpm/action-setup@...# v4.2.0`, `gradle/actions/setup-gradle@...# v4.4.3`. `.github/renovate.json` groups GitHub Actions updates, so open major bumps are probably waiting in a Renovate PR. I did not check the network for current versions or the runner deprecation date; treat the versions as "verify first". One `actions/checkout` pin (`apple.yml`) and one `upload-artifact` pin lack the `# vX` comment the other 60 carry.
- Fix: merge the Renovate "github actions" group, or bump by hand; add the two missing version comments.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run test/ci` and one green run of each workflow.

### TOOL-27: tooling files carry long incident-history comments that the working rules exclude
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: root `AGENTS.md` working rules: "Write comments only for public APIs, tool directives, or constraints that code cannot show." Counter-examples: `.github/workflows/ci.yml:43-48` and `:69-79` (two paragraphs of PR history for a grep step and the DI-seam gate), `vitest.config.ts:23-52` (30 lines of failure history for one project split, including a removal condition "after 30 consecutive Coverage runs" with no tracker), `scripts/gate/declarations.ts:3-8,18-20` (comments describing entries that are now empty). The `scripts/layering/*` "Catches / Evidence / Cost / Kill criterion" headers are a deliberate convention and are not part of this finding.
- Fix: move the history to the linked issues or PRs and keep one line that states the constraint. For the `fuzz-worker` split, record the removal condition in an issue and check whether it is already met.
- Effort: M
- Model: sonnet
- Verify: `pnpm check:gate-manifest:test` and `pnpm exec vitest run test/ci` (some tests read workflow text).
