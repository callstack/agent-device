# Audit slice TEST2: the unreached parts of `test/`, `examples/test-app`, `website/src`

## Coverage

Read-only audit. Nothing was built and no gate was run. I ran `git`, `grep`, and three throwaway scripts in the scratchpad (an unused-export scan, a copy of the exec-wrap guard logic pointed at `packages/*/src`, and a call of `findClosureGaps` with the waivers removed).

- **Read in full (about 30% of this slice by lines):**
  - `test/repo-guards/`: `exec-wrap-guard`, `gesture-max-contacts-parity`, `runner-derived-root`, `runner-source-assertions`, `runner-startup-reason-docs`, `npm-package-scripts`, `android-helper-accessibility-services`, `apple-runner-log-redaction`, `macos-helper-package-contents`, `package-exports`, `runner-requests`, `snapshot-bridge-refusals`.
  - `test/wire-compat/`: `wire-compat.test.ts`, `ledger.ts`, `closure.ts`, `closure-policy.ts`. `test/replay-compat/`: `corpus.test.ts`, `provenance-rules.ts`.
  - `test/integration/provider-scenarios/`: `harness.ts`, `scenario.ts`, `transcript.ts`, `providers.ts`, `assertions.ts`, `fixtures.ts`, `test-timeouts.ts`, `android-world.ts`, `android-settings-contract.ts`, the three `*.coverage.ts` files, and the tests `interaction-direct-selector-fallback`, `provider-command-dispatch`, `android-uninstall`, `android-recording-provider-fixtures`, `limrun-ios-settings`.
  - `test/integration/interaction-contract/`: `coverage-manifest.ts`, `index.ts`, all `*.coverage.ts`, `runtime-harness.test.ts`, `maestro-direct-selector.contract.test.ts`, `resolution-disclosure-mutation.contract.test.ts`, and the gate `src/__tests__/contracts/interaction-contract-coverage.test.ts`.
  - `test/integration/android-emulator-e2e/{live-runner,live-harness,contract-evidence,coverage}.ts`, `ios-simulator-e2e/{live-harness,coverage}.ts`, `macos-e2e/coverage.ts`, `command-coverage/entries.ts` (first 140 lines).
  - `examples/test-app`: `package.json`, `app.config.js`, `pnpm-workspace.yaml`, `tsconfig.json`, `src/theme.ts`, `src/route-params.ts`, `src/lab-state.tsx` (first 120 lines), `replays/checkout-form.ad`.
  - `website`: `astro.config.mjs`, `ec.config.mjs`, `tsconfig.json`, `PixelIcon.astro`.
- **Scanned by script or grep (about 45%):**
  - All 70 provider-scenario test files: transcripts created against `assertComplete()` calls, assertion counts, skips, real-time sleeps, and every local helper function name defined in more than one file.
  - Every exported name in non-test files under `test/`, `examples/test-app/src`, `website/src` for a reference elsewhere in the repo.
  - Every dependency of `examples/test-app` and `website` for an import or config reference; every `.astro` component and site `.ts` module for an importer; every class selector in the three website stylesheets for a use; every icon in `icons.ts` for a use.
  - Every `key === '...'` matcher in `android-world.ts` against the adb argv that production builds.
  - `test/wire-compat/surface.ts` (first 170 lines), `test/replay-compat/manifest.ts` (first 110 lines), `ios-world.ts` lines 150-330, `remote-proxy-parity.test.ts` lines 60-260, `scroll-movement-observation.test.ts` lines 240-285, `ios-simulator-e2e/live-runner.ts` lines 1-140, `apple-runner-package-source.test.ts` lines 1-140, test titles of the remaining repo-guards.
- **Not reached (about 25%):** the bodies of most provider-scenario tests (for example `android-lifecycle`, `remote-daemon-client`, `settle-observation`, the `cloud-webdriver-*` files and their fake WebDriver server), `find-focus-dispatch`, `runtime-selector`, `runtime-ref` and `interaction-response-shape` contract tests, `wire-mutations.test.ts`, `declaration-digest.ts`, `module-resolution.ts`, the live scenario bodies under `*-e2e/`, `command-coverage/declarations.ts`, the bodies of `capability-matrix`, `command-doc-coverage`, `interaction-guarantees`, `snapshot-producer-emitters`, most test-app screen bodies, `website/src/pages/*.astro` markup, `dither.ts`.

Checked and found clean (not findings): no `.skip`, `.only` or `.todo` in the slice (one runtime `t.skip` for a sandbox limit); no fixed sleep above 50 ms in provider scenarios; the transcripts that never call `assertComplete()` use only `repeat` entries, or are closed by their shared wrapper; every `examples/test-app` dependency is imported, named in config, or a required `expo-router` peer; every website dependency, component and site module is used; `examples/test-app/src` has no unused component, data export or context field; the replay-compat corpus checks are bound to git blob ids and cannot be satisfied by an edit to the script.

## Findings

### TEST2-1: `exec-wrap-guard` scans only root `src/`, so it misses 87% of `AppError` sites, including two real violations
- Category: broken
- Severity: high     Confidence: high
- Evidence:
  - `test/repo-guards/exec-wrap-guard.test.ts:25` sets `SRC_ROOT` to `<repo>/src`, and `:95` scans only that tree.
  - Non-test `new AppError(` sites: 143 under `src/`, 997 under `packages/*/src`.
  - All 9 files that carry the guard's `// exec-guard-allow:` marker are under `packages/` (for example `packages/host-kit/src/internal/exec.ts:660`, `packages/platform-android/src/app-control.ts:99`). The guard reads none of them, so the markers are inert.
  - The guard's own logic, run over `packages/*/src`, reports 4 sites. Two are the exact bug the guard exists for (the `stdout`/`stderr`/`exitCode` trio with no `processExitError`, so `normalizeError` drops the stderr excerpt): `packages/platform-apple/src/readiness/runtime.ts:111` (`'simctl boot failed'`) and `:141`. Two set the flag by hand instead of using `execFailureDetails`: `packages/platform-android/src/adb-failure.ts:295`, `packages/platform-vega/src/inventory.ts:83`.
- Fix: scan `src` and every `packages/*/src` in `exec-wrap-guard.test.ts`. Change the four sites to `execFailureDetails()`/`requireExecSuccess()` from `@agent-device/host-kit/command`, or add an allow marker with a reason.
- Effort: S
- Model: sonnet (the two `readiness/runtime.ts` sites change a user-visible error message; review the wording)
- Verify: `pnpm exec vitest run --project unit-core test/repo-guards/exec-wrap-guard.test.ts` fails before the four fixes and passes after.

### TEST2-2: `package-exports` guard checks a stale hand-kept list and does not enforce "only"
- Category: broken
- Severity: medium     Confidence: high
- Evidence:
  - `test/repo-guards/package-exports.test.ts:22-36` lists 13 subpaths. `package.json` `exports` has 15: `./plugins` and `./plugins/webdriver` are absent from the list.
  - Those two subpaths therefore skip all four checks (tsdown entry exists, source exists, `types` matches `import`, module has named exports).
  - The test named "package exports only supported public subpaths" (`:64-72`) asserts that each listed subpath exists and that three removed names (`./android-apps`, `./daemon`, `./host`) are absent. Any new, unlisted subpath passes.
- Fix: derive the checked set from `Object.keys(pkg.exports)` and assert it equals the supported list (add the two plugin subpaths). Drop the three tombstone assertions; the equality check covers them.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run --project unit-core test/repo-guards/package-exports.test.ts`; add a temporary `./x` export and confirm the test fails.

### TEST2-3: Android command-contract evidence is checked in one direction, and the largest entry skips the file check
- Category: broken
- Severity: medium     Confidence: high
- Evidence:
  - `test/integration/smoke-android-emulator-coverage.test.ts:228-236` checks that the owner file exists and contains the test title only when `evidence.owner.endsWith('.ts')`.
  - `ANDROID_LIFECYCLE_CONTRACT_EVIDENCE` (`test/integration/provider-scenarios/android-lifecycle.coverage.ts:4-25`) has owner `'provider-scenarios/android-lifecycle'`, and `ANDROID_INSTALL_SOURCE_CONTRACT_EVIDENCE` (`src/__tests__/install-source.coverage.ts:5`) has owner `'provision-kit/install-source'`. Neither is a path, so the check is skipped for both. The lifecycle entry is the contract owner of 8 commands in `command-coverage/declarations.ts`.
  - The only command check is `entry.evidence.commands.includes(command)` (`smoke-android-emulator-coverage.test.ts:34-37`). Nothing checks the reverse. The lifecycle evidence declares 16 commands; `declarations.ts` uses it for 8 (boot, shutdown, network, clipboard, reinstall, triggerAppEvent, reactNative and one more). The rest (batch, events, gesture, logs, perf, push, settings, swipe, trace) are now owned by live scenarios but stay claimed.
  - Three evidence objects are consumed by no coverage table: `ANDROID_TOUCH_CONTRACT_EVIDENCE` (`android-lifecycle.coverage.ts:27`), `ANDROID_TEST_SUITE_CONTRACT_EVIDENCE` (`android-test-suite.coverage.ts:4`), `ANDROID_RECORDING_CONTRACT_EVIDENCE` (`android-recording.coverage.ts:4`). `declarations.ts:404,851,1244` make `test`, `record` and `scroll` live on Android. Their only use is `.testName` as a test title.
- Fix: make every owner a repo path (`test/integration/provider-scenarios/android-lifecycle.test.ts`, `packages/provision-kit/src/...`) and remove the `.endsWith('.ts')` condition. Add a reverse check that each `evidence.commands` member is a `command-contract` row that uses that evidence, then trim the lifecycle list. Delete the two orphan `.coverage.ts` files and the touch constant; put the titles inline.
- Effort: S
- Model: sonnet
- Verify: `pnpm test:smoke` (file `test/integration/smoke-android-emulator-coverage.test.ts`); `pnpm test:integration:provider`.

### TEST2-4: Apple `simctl` fakes answer success to any unmodeled command, against the suite's own strictness rule
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - The shared rule: `providers.ts:214-225` (`simctlDeviceLifecycleHandler`) and `android-world.ts:253` throw `Unscripted <platform> provider call` for anything unmodeled, and `provider-command-dispatch.test.ts:5-22` exists only to prove that both do.
  - Five hand-written `simctl` handlers end in `return { stdout: '', stderr: '', exitCode: 0 };` for every other argv: `ios-world.ts:233`, `ios-world.ts:302`, `ios-world.ts:364`, `ios-alert-settings.test.ts:90`, `apple-platform-output-guard.test.ts:281`. `apple-platform-output-guard.test.ts:283` does the same for every `devicectl` call.
  - Effect: in the main iOS world (`createIosSettingsWorld`, used by `ios-lifecycle.test.ts`), a production change that adds, renames or drops a `simctl` call still gets exit 0 and empty output. The scenario fails only if a later assertion happens to name that call.
  - The same files also re-inline the device-list JSON that `simctlListDevicesResult` owns (`ios-wait-selector.test.ts:21-31`, `ios-fold.test.ts:86-96` and `:214`).
- Fix: build each handler on `simctlDeviceLifecycleHandler` (as `scroll-movement-observation.test.ts:121-130` already does), add the specific commands each scenario needs, and let the rest throw. Expect a few scenarios to surface calls that were silently accepted; model those explicitly.
- Effort: M
- Model: opus (each newly failing call needs a decision: model it or fix production)
- Verify: `pnpm test:integration:provider`.

### TEST2-5: Interaction-contract coverage gate accepts a claim that no test carries
- Category: broken
- Severity: medium     Confidence: medium
- Evidence:
  - `src/__tests__/contracts/interaction-contract-coverage.test.ts:23-39` validates a coverage entry by path, guarantee and `entry.scenario.trim().length > 10`. No check reads the contract test files, so a manifest row with no registered test satisfies "every enforced matrix cell has at least one contract scenario" (`:54-70`).
  - `test/integration/interaction-contract/coverage-manifest.ts:13-16` states the opposite: "a claim without a matching scenario cannot be written by accident", because test files derive titles through `scenarioName`.
  - That derivation is optional. `maestro-direct-selector.contract.test.ts:10` hard-codes the title as a string literal, and `maestro-direct-selector.coverage.ts:3-4` holds a second copy in an unexported constant. An edit to either one leaves the gate green while the two claimed cells (`responseConstruction`, `resolutionDisclosure`) point at no test.
  - Array claims are indexed by hand (`scenarioNames(...)[1]!` in `runtime-selector.contract.test.ts:57,99,250,298,389,450`), so a third entry added to a manifest array is a silent claim.
- Fix: add one helper in `coverage-manifest.ts`, `contractTest(coverage, guarantee, index, fn)`, that registers the Vitest test and records the title; use it in all eight contract files. In each file add an `afterAll` (or one aggregate test) that fails when a manifest scenario was never registered. Export the constant from `maestro-direct-selector.coverage.ts` and use it.
- Effort: M
- Model: sonnet
- Verify: `pnpm exec vitest run --project interaction-contract`; add a fake manifest row and confirm a failure.

### TEST2-6: Four of the thirteen wire-closure waivers are never reached, and nothing reports a stale waiver
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `findClosureGaps` with `waivers: {}` reaches 9 of the 13 keys in `WIRE_CLOSURE_WAIVERS`. Never reached: `packages/kernel/src/errors.ts#AppErrorCode`, `packages/kernel/src/errors.ts#AppErrorDetails`, `packages/contracts/src/daemon-wire-request.ts#DaemonWireRequestMeta`, `packages/contracts/src/request-progress.ts#RequestProgressSink` (`test/wire-compat/closure-policy.ts:43,45,53,59`).
  - Cause: `test/wire-compat/closure.ts:51-64` reads the type references of listed declarations only. It does not descend into a waived type. `closure-policy.ts:17` says "A waiver stops the walk", which implies a recursion that does not exist; the four entries waive types that sit behind other waived types.
  - `wire-compat.test.ts:76-95` rejects a stale `compatibleChanges` ack, but no test rejects a stale waiver. A waiver for a type that later becomes payload elsewhere would pre-approve it.
- Fix: delete the four entries. In `wire-compat.test.ts`, add a test that runs `findClosureGaps` with no waivers and asserts every waiver key is in the reached set. Correct the comment at `closure-policy.ts:17`.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run --project unit-core test/wire-compat`.

### TEST2-7: Provider-scenario scaffolding is copied between test files
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `snapshotEntry` (an `ios.runner.snapshot` transcript entry) is defined in 7 files: `versioned-refs.test.ts:49`, `settle-observation.test.ts:125`, `interaction-verify.test.ts:49`, `press-selector-resolution.test.ts:42`, `interaction-direct-selector-fallback.test.ts:40`, `stale-ref-warning.test.ts:65`, `scroll-movement-observation.test.ts:83`. `tapEntry` is defined in 4 of them with identical bodies. `interaction-contract/daemon-harness.ts` already exports `runnerSnapshotEntry` and `runnerTapEntry` for the same shapes.
  - `leaseFlags`/`leaseMeta` are defined in 5 files (`provider-device-runtime.fixtures.ts:480,490` exports them; `cloud-webdriver-runtime.test.ts:644`, `cloud-webdriver-ios-text-entry.test.ts:654`, `provider-ios-selector-runtime.test.ts:213`, `provider-ios-runner-transport.test.ts:432` redefine them with only provider, platform and device key changed). `allocateLease` is defined in 4 files.
  - `androidRepairAdbResult` in `replay-repair-abort-close.test.ts:113-141` is a line-for-line copy of the exported one in `replay-repair-world.ts:7-35` (`diff` shows only the `export` keyword).
  - `assertCommandCall` and `assertFlatToolCall` (`assertions.ts:6-22`) have the same body.
  - `createFetchBackedHttpsRequest` and `fetchNodeResponse` are duplicated between `test/integration/support/exit-after-flush.ts:97-134` and `support/provider-disconnect-fetch.mjs:68-100`. `readDaemonInfo` is defined in 3 smoke tests (`daemon-replace-exit-flush.test.ts:102`, `smoke-daemon-http.test.ts:82`, `smoke-daemon-clean.test.ts:148`).
- Fix: move `runnerSnapshotEntry`/`runnerTapEntry` to `provider-scenarios/transcript.ts` (or a new `ios-runner-entries.ts`) and import them in the 7 files and in `daemon-harness.ts`. Add `leaseFlags(provider, platform, extra)` and `leaseMeta(...)` to `provider-device-runtime.fixtures.ts`. Import `androidRepairAdbResult` from `replay-repair-world.ts`. Keep one of the two call assertions.
- Effort: M
- Model: sonnet
- Verify: `pnpm test:integration:provider`; `pnpm exec vitest run --project interaction-contract`; `pnpm check:fallow`.

### TEST2-8: `android-world.ts` models adb commands that production does not send
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `android-world.ts:560-571` answers `shell dumpsys cpuinfo`. `git grep cpuinfo` finds no other hit in the repository.
  - `android-world.ts:366` accepts `am start-activity`. `git grep start-activity` finds no other hit.
  - `android-world.ts:494-499` accepts the unscoped five-word `pm grant|revoke` form. `packages/platform-android/src/settings-permission.ts:143` always sends `--user <id>` since #1796. The fake would accept a regression to the unscoped form; only `android-settings-contract.ts:20-28` pins the scoped form, and only for the one camera grant.
- Fix: delete the `cpuinfo` branch and the `start-activity` alternative. Require `args[3] === '--user'` in `androidPermissionMutationAdbResult`.
- Effort: S
- Model: sonnet
- Verify: `pnpm test:integration:provider`.

### TEST2-9: `provider-scenarios` harness leaks process state when world creation fails
- Category: broken
- Severity: low     Confidence: medium
- Evidence:
  - `android-world.ts:70-74` installs the host-adb guard (prepends a temp dir to `process.env.PATH`, sets `AGENT_DEVICE_TEST_ADB_ARGS_FILE`, deletes `AGENT_DEVICE_HTTP_AUTH_HOOK`) before `createAndroidManifestApk` (`:93`, which asserts on a host `zip` binary at `:229-233`) and before `createProviderScenarioHarness` (`:154`). Neither is in a `try`. If either throws, `hostAdbGuard.restore()` never runs and `tempRoot` stays.
  - `harness.ts:342-352`: `withProviderScenarioResource` awaits `create()` outside the `try`, so a creator cannot rely on it for cleanup.
  - `harness.ts:279-290`: `close()` removes the temp root only if `runtime.close()` resolves.
  - `harness.ts:298-320`: `postProviderScenarioRpc` accepts a `signal` that no caller passes.
- Fix: wrap the body of `createAndroidSettingsWorld` after the guard in `try { ... } catch { restore; rm tempRoot; throw }`. Use `try/finally` in `close()`. Remove the unused `signal` parameter.
- Effort: S
- Model: sonnet
- Verify: `pnpm test:integration:provider`.

### TEST2-10: Dead rules in `website/src/styles/landing.css`
- Category: unneeded
- Severity: low     Confidence: high (medium for `.term`, see below)
- Evidence: these selectors have no match in any `.astro`, `.ts`, `og/og.html` or script under `website/` (searched as whole words, and for dynamic forms such as `cells--${n}` and `class:list`): `.cells--2` (`landing.css:353,374,608`), `.chip--line` (`:262`), `.chip--agent` (`:269`), `.chips` (`:411`), `.is-pending` and `.ghost` (`:288-289`), `.pkg` (`:326`), `.foot-link` (`:443`), `.tab-bar` (`:453,599`), `.hero-copy` (`:489,495`), `.intro--sub` (`:632`), and the `.term` block with its `.ln/.p/.user/.tool/.dim/.out/.ok/.add/.del/.k/.s` children (`:519` onward). `Hero.astro:89` emits `ln` and a kind class, but under `.out`, not under `.term`; the only other `term` hit is a comment in `Window.astro:3`.
- Fix: delete the listed rules. Check the hero transcript in a browser first, because its line colours may have been meant to come from the `.term` rules.
- Effort: S
- Model: sonnet
- Verify: `pnpm --dir website build`; compare the landing, cloud, showcase and 404 pages before and after.

### TEST2-11: Thirteen of the twenty pixel icons are unused
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `website/src/components/site/icons.ts` defines 20 icons. `PixelIcon` is rendered with `package` (`Hero.astro:43`), `star` (`GitHubStars.astro:27`), `search` (`DocsSearch.astro:10`) and `p.icon` (`cloud.astro:33`), whose values are `panel`, `flag`, `network`, `cube` (`content.ts:451-475`). No other code indexes `icons`. Unused: `signpost`, `database`, `gauge`, `faders`, `folder`, `table`, `stack`, `flame`, `form`, `grid`, `lock`, `code`, `test` (about 140 lines). Fallow cannot see them because they are keys of one exported object.
- Fix: delete the 13 entries.
- Effort: S
- Model: sonnet
- Verify: `pnpm --dir website check` (`IconName` narrows, so a missed use is a type error); `pnpm --dir website build`.

### TEST2-12: Tombstone and source-regex assertions in `npm-package-scripts.test.ts`
- Category: broken
- Severity: low     Confidence: medium
- Evidence:
  - `test/repo-guards/npm-package-scripts.test.ts:32,37-38,45` assert that `build:dev`, `perf:ios`, `perf:android` and `fallow` scripts do not exist. These fail only if someone re-adds a script with that exact name.
  - `:66-90` assert that `scripts/check-package.ts` contains certain text (`/--pack-destination/`, `/packDestination/`, the literal call strings `auditDependencyClosure(installedRoot, manifest)` and so on). A call that is present but unreachable, or renamed with the same behavior, gives the wrong result in both directions. `scripts/check-package.ts` runs for real in the `check:package` gate, which is the behavior proof.
- Fix: delete the absence assertions and the text-match tests for `check-package.ts`; keep the tests that pin script composition and the MCP publisher ordering. If the pack-destination and notifier behaviors need a guard, test them through `scripts/check-package.ts` exports.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run --project unit-core test/repo-guards/npm-package-scripts.test.ts`; `pnpm check:package`.

### TEST2-13: iOS `checkout-form.ad` and the Maestro fixture suite run in no lane; the website "excerpt" does not match the file
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence:
  - `examples/test-app/replays/checkout-form.ad` is referenced only in comments (`packages/daemon/src/core/__tests__/post-gesture-stabilization.test.ts:200,377`, `interaction-surface-signature.test.ts:35`) and by `website/src/site/content.ts:569`. The iOS live lane runs `gesture-lab.ad` and `drag.ad` (`test/integration/ios-simulator-e2e/live-replay-scenarios.ts:55-56`); the Android lane runs `checkout-form-android.ad`. Only the manual `pnpm test-app:replay:ios` reaches the iOS file.
  - `examples/test-app/maestro/checkout-form.yaml` and `maestro/helpers/` are reached only by the manual `pnpm test-app:maestro:*` scripts (`package.json:200-202`, `CONTRIBUTING.md:311-312`); no workflow or gate names them.
  - `website/src/site/content.ts:569-578` is labelled "An excerpt of examples/test-app/replays/checkout-form.ad", but its `open` line is `open "${APP_TARGET}" --relaunch` while the file has `open "${APP_TARGET}" --relaunch --launch-url "${APP_URL}"`, and the listed steps skip the waits the file needs between them. Nothing checks the two against each other.
- Fix: add the iOS checkout replay to `ios-simulator-e2e/live-replay-scenarios.ts` (the Android twin already runs), or delete it and point the two test comments at `test/integration/replays/ios/fixture/02-checkout-release.ad`. Relabel the website script as illustrative, or generate it from the file.
- Effort: S
- Model: opus (if the replay is wired into the iOS lane), sonnet otherwise
- Verify: the iOS replay lane run; `pnpm --dir website build`.

### TEST2-14: `test/wire-compat/ledger.ts` cites a script that does not exist
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `test/wire-compat/ledger.ts:6` names `scripts/check-daemon-wire-compat.ts` as the reader of the released ledger. That file does not exist; `package.json:177` runs `scripts/wire-compat/run.ts`.
- Fix: change the comment to `scripts/wire-compat/run.ts`.
- Effort: S
- Model: sonnet
- Verify: `git grep -n check-daemon-wire-compat.ts` returns nothing.

### TEST2-15: Unused fixture export `SCREENSHOT_RESULT`
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `test/output-economy/fixtures.ts:149` exports `SCREENSHOT_RESULT`. `git grep -w SCREENSHOT_RESULT` finds only that line.
- Fix: delete the constant.
- Effort: S
- Model: sonnet
- Verify: `pnpm test:output-economy`; `pnpm typecheck`.
