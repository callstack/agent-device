# Audit slice DOCS: tests, test-kit, examples, website, docs, skills, root markdown

## Coverage

Read-only audit. Nothing was built or run except `git`, `grep`, and small throwaway scan scripts in the scratchpad.

- **Fully read / mechanically verified (about 45% of the slice by lines, 100% of the doc surface by mechanical scan):**
  - Every tracked `*.md` in the slice was scanned by script for: `pnpm <script>` names vs `package.json`, backticked repo paths vs `git ls-files`, relative Markdown links, `--flags` vs flags in code, `UPPER_SNAKE` env/constant names vs code, and backticked identifiers vs code.
  - Read in full: `AGENTS.md`, `docs/agents/{testing,gates,code-ownership,test-authoring,device-verification}.md`, `docs/adr/README.md`, `docs/adr/FORMAT.md`, all four `skills/*/SKILL.md`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `examples/README.md`, `examples/sdk/tsconfig.json`, `examples/test-app/package.json` + `pnpm-workspace.yaml`, `website/{package.json,astro.config.mjs,vercel.json,src/content.config.ts}`, `website/scripts/build-depgraph.mjs`, `vitest.config.ts`, `scripts/check-affected/checks.ts`, `packages/test-kit/{package.json,src/index.ts}`, `test/output-economy/{README.md,budget-guard.ts,output-economy.baseline.test.ts,waivers}`, `test/repo-guards/{adr-citations,client-api-examples-drift}.test.ts`.
  - Status paragraph of all 38 ADRs; test selection of every `*.test.*` under `test/` against vitest projects, package scripts, the gate catalog and `.github/workflows`.
- **Skimmed (about 25%):** `README.md`, `CONTRIBUTING.md`, `CONTEXT.md`, `website/docs/docs/*.md` (all TypeScript snippets extracted and read; `configuration.md` env table read), `website/src/site/{content,llms}.ts`, `test/integration/*.test.ts` (titles, skip conditions, helpers), `test/integration/test-helpers.ts`, `test/scripts/*.sh`, ADRs 0011/0016/0018/0020/0024/0025 around the cited lines, `docs/dependency-graph-findings.md`, `docs/evidence/*` (headers + reference counts only).
- **Not reached (about 30%):** bodies of the 102 files in `test/integration/provider-scenarios/`, `test/integration/interaction-contract/`, the per-platform `*-e2e/` live runners, `test/wire-compat/*` and `test/replay-compat/*` internals, most `test/repo-guards/*` bodies, `examples/test-app/src/**` screen code, website `.astro` components and CSS, bodies of most ADRs.

Things checked and found clean (not findings): every `pnpm` script named in docs exists; no broken relative Markdown links outside the gated website; all 30 website docs pages are in the sidebar; all website components/pages/scripts are referenced; all 15 `package.json` export subpaths are documented; documented flags and env vars all exist in code; no test file in `test/` is unselected by every lane; `@agent-device/test-kit` has no unused runtime export (only 15 unused type exports); `THIRD_PARTY_NOTICES.md` counts and pins match; workflow cron times match `CONTRIBUTING.md`.

## Findings

### DOCS-1: Recording E2E tests (and their support code) are run by no lane
- Category: unneeded
- Severity: high     Confidence: high
- Evidence:
  - `test/integration/recording-overlay.test.ts:13,320,327` and `test/integration/recording-contact-sheet.test.ts:7,223` — all 7 tests skip unless `AGENT_DEVICE_RECORDING_E2E` is set.
  - `git grep RECORDING_E2E` finds no setter in `.github/`, `scripts/`, or `package.json`; the only other hits are a code comment (`src/platform-runtime-screen-recording-finalizer-host.test.ts:183`) and `docs/adr/0025-foldable-apple-panels.md:511`.
  - Dead weight behind the switch: the two test files (579 lines), `test/integration/support/recording-inspect.swift` (259), `test/integration/support/recording-overlay-fixture.swift` (63), and about 330 of the 343 lines of `test/integration/test-helpers.ts` (`createIntegrationTestContext`, `runRecordingInspect`, `analyzeOverlayCrop` have no other caller; only the 3-line `runCliJson` wrapper is used by live tests, at `daemon-replace-exit-flush.test.ts:11`, `smoke-daemon-clean.test.ts:14`, `smoke-daemon-http.test.ts:12`).
  - The tests hard-code device coordinates (`recording-overlay.test.ts:152` `press 201 319`), so they have likely rotted.
  - `docs/agents/test-authoring.md` requires "a PR or scheduled lane that runs the scenario at the actual head" for automatic coverage.
- Fix: either wire the switch into an existing device lane (`.github/actions/smoke-ios-run/action.yml`, `android.yml`, or `replays-nightly.yml`) and fix what fails, or delete the two tests, the two Swift support files and the unused helpers, leaving `runCliJson` (callers can import `runSourceCliJsonSync` from `cli-json.ts` directly). Update the ADR 0025 sentence either way (see DOCS-7).
- Effort: M
- Model: opus (device behavior if wired; sonnet if deleted)
- Verify: `git grep -n RECORDING_E2E` shows a workflow setter, or returns nothing after deletion; `pnpm test:integration:node`.

### DOCS-2: Spent output-economy waivers stay live; two of them pre-authorize a 5x size regression
- Category: broken
- Severity: medium     Confidence: high
- Evidence:
  - `test/output-economy/budget-guard.ts:63-69` — a waiver applies whenever `waiver[metric] === current`, with no link to the base value it was written for.
  - `test/output-economy/output-economy.waivers.json` has 11 entries. For 9 the waived bytes equal the committed baseline (e.g. `snapshot.digest.json` 214/214), so the merge-base already contains them and they can never apply again.
  - `mcp.snapshot.default.json` and `workflow.orient.mcp.json` both waive `bytes: 1239`, while `output-economy.baseline.json` now records 228 for both. A future change that inflates either sample from 228 back to exactly 1239 bytes passes "does not raise merge-base byte or line budgets" with no new review.
  - Nothing removes or rejects a waiver once the baseline absorbed it (`output-economy.baseline.test.ts:27-29`).
- Fix: empty `output-economy.waivers.json` now. In `budget-guard.ts`, make a waiver name the base value it raises from (`from`), or add a test in `output-economy.baseline.test.ts` that fails when a waiver's value does not exceed the merge-base value for that sample (a spent waiver). Update `test/output-economy/README.md`.
- Effort: S
- Model: sonnet
- Verify: `pnpm test:output-economy`; add a budget-guard case where a stale waiver must not excuse an increase.

### DOCS-3: ADR 0018 says "Nothing in this proposal is implemented" but the journal ships as a package
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - `docs/adr/0018-unified-event-journal.md:5-6` — "Proposed (2026-07-24 ...). Nothing in this proposal is implemented."; `docs/adr/README.md` lists it as "(Proposed)".
  - `packages/session-journal/package.json:7` — "The ADR 0018 unified request event journal: the append-only per-session event log ...".
  - Code cites it as a governing rule: `packages/session-journal/src/session-event-log-window.ts:29`, `packages/daemon/src/server/http/daemon-session-idle-expiry.ts:93`, `packages/host-kit/src/code-signature.test.ts:181`.
  - The ADR still names `EVENT_CATALOG`, `EventKind`, `UsageRecord`, `parentScopeId`, none of which exist in code, so a reader cannot tell which part landed.
- Fix: amend `docs/adr/0018-unified-event-journal.md` Status to state what is implemented (the session event log in `packages/session-journal`) and what remains proposed; update the `docs/adr/README.md` row.
- Effort: S
- Model: opus (needs a read of `packages/session-journal` to state the truth)
- Verify: `pnpm check:adr-citations`; manual read against `packages/session-journal/src`.

### DOCS-4: ADR 0024 is "Proposed" while 39 files implement and cite its rules; FORMAT.md forbids proposed ADRs
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - `docs/adr/0024-screen-recording-provable-signal.md:5` — "Proposed (2026-09-14)", yet line 11 says "Completed rollout history is in git history."
  - `docs/adr/0019-request-bound-platform-runtime.md` Status — "The screen-recording amendment in ADR 0024 remains proposed."
  - 39 files cite it as in force, e.g. `packages/capture-kit/src/durable-capture/definition.ts:27` ("ADR 0024 rule 6"), `packages/capture-kit/src/capture-admission/screen-recording-session-resource.ts:44`, `.fallowrc.json:318` ("stop-sequence contract (ADR 0024 §2.3)").
  - `docs/adr/FORMAT.md` — "Keep a proposal in an umbrella issue. ... An ADR records accepted decisions only." Three records violate it: 0018, 0024, and `0020-composable-recorded-fragments.md` (792 lines, "Proposed design spike", cited by zero files, none of its `fragment_*` reasons exist in code).
- Fix: mark 0024 Accepted (and fix the pointer line in 0019). Move 0020 to its issue (#1336) or shrink it to the accepted contract; align the README index titles.
- Effort: S
- Model: opus
- Verify: `pnpm check:adr-citations`; `pnpm check:agent-guidance`.

### DOCS-5: `browserstack.md` TypeScript snippet does not typecheck; the snippet guard compiles only 2 of 12 pages
- Category: broken
- Severity: medium     Confidence: high (snippet), medium (other pages unverified)
- Evidence:
  - `website/docs/docs/browserstack.md:117` — `console.log(artifacts.cloudArtifacts);` with no narrowing.
  - `packages/contracts/src/cloud-artifacts.ts:59-67` — `AgentArtifactsResult = CloudArtifactsResult | DaemonArtifactsResult`, and `DaemonArtifactsResult` has no `cloudArtifacts`. The sibling pages narrow correctly: `client-api.md:82` and `testmu.md:191` use `'cloudArtifacts' in ...`.
  - `test/integration/client-api-doc-snippets.test.ts:23-26` compiles only `client-api.md` and `build-an-integration.md` (20 fences). 12 ` ```ts ` fences in `ai-sdk`, `aws-device-farm`, `browserstack`, `eve`, `limrun` (2), `migrating-gestures`, `plugins` (2), `replay-e2e`, `revyl`, `testmu` are never compiled.
  - `examples/sdk/tsconfig.json` `paths` (which that test reuses) lacks `agent-device/limrun`, `agent-device/plugins`, `agent-device/plugins/webdriver`, so those pages could not be added today.
- Fix: narrow in `browserstack.md`. Add the three missing subpaths to `examples/sdk/tsconfig.json` `paths`, then extend `API_DOC_PATHS` to the provider pages whose snippets are complete programs (browserstack, aws-device-farm, testmu, limrun, revyl needs `@agent-device/revyl` mapping); leave fragment-only snippets (`plugins.md` second fence, `migrating-gestures.md`) out explicitly.
- Effort: M
- Model: sonnet
- Verify: `node --experimental-strip-types scripts/node-test-tmpdir.ts --test test/integration/client-api-doc-snippets.test.ts`; `pnpm typecheck`.

### DOCS-6: Fake managed agent-browser fixture is duplicated verbatim in test-kit and platform-web
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - `packages/test-kit/src/web-managed-agent-browser.ts:7-86` and `packages/platform-web/src/__tests__/test-utils.ts:16,130-219` — `installFakeManagedAgentBrowser`, `writeFakeManagedAgentBrowserPackage`, `withNodeRuntime`, `expectedManagedAgentBrowserInstall`, `sha1Short` are line-for-line the same (a `diff` shows only two added comments and one extra helper).
  - Both hard-code `TEST_AGENT_BROWSER_VERSION = '0.39.0'` and both re-derive the install path that production owns (`packages/platform-web/src/agent-browser-tool.ts:34` `MANAGED_AGENT_BROWSER_VERSION`, `managedInstallPaths`). A version bump needs three edits; missing one makes the fixture install a directory production never reads.
  - `packages/platform-web` already depends on `@agent-device/test-kit` (`package.json:25`) and test-kit does not depend on platform-web, so the "packages test-kit depends on keep helpers local" rule in `docs/agents/test-authoring.md` does not require the copy.
- Fix: delete the copies from `packages/platform-web/src/__tests__/test-utils.ts` and import from `@agent-device/test-kit` (keep `writeFakeNpmCliScript` local or move it too). Update the 7 platform-web test files that import them from `test-utils.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm exec vitest run --project unit-core packages/platform-web`; `pnpm check:fallow`.

### DOCS-7: Accepted ADRs name code that does not exist
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence (each identifier has zero hits in `src`, `packages`, `scripts`, `test`, native trees):
  - `docs/adr/0011-interaction-guarantee-contract.md:151,154` — lists `isNodeVisibleOnScreen` and `describeResolvedNode` as homes that "already exist"; line 373 names `resolveUnverifiedWrapperControl` as where the collapse "now sits".
  - `docs/adr/0016-active-session-script-publication.md:155` — "`buildNextOpenSession` and the close finalizer now make no recording decision".
  - `docs/adr/0025-foldable-apple-panels.md:510-511` — says `test/integration/recording-overlay.test.ts` "carries the on-device completion measurements for a non-rot90 target and Duo inner panel"; that file has no fold or Duo case, and never runs (DOCS-1).
  - `docs/adr/FORMAT.md` — "An ADR states the current truth." The `adr-citations` guard covers only tokens with a file extension, so symbol drift is unguarded.
- Fix: replace each stale symbol with its current owner (find via the registry `via` fields in `packages/contracts/src/interaction-guarantees.ts`) or reword in prose without backticks; correct the 0025 sentence.
- Effort: S
- Model: opus (needs the current owner of each rule)
- Verify: for each replaced name, `git grep -nw <name> -- src packages` returns a definition.

### DOCS-8: `docs/dependency-graph-findings.md` describes a tree that no longer exists and contradicts the shipped viewer
- Category: unneeded
- Severity: medium     Confidence: high
- Evidence:
  - 52 backticked paths in it resolve to nothing, e.g. `daemon/types.ts` (lines 103, 140, 240, 247, 251, 490), `core/dispatch.ts:430`, `platforms/apple/plugin.ts:293`, `providers/limrun/android.ts:464`, `daemon/handlers/lease.ts:299` — these directories moved out of `src/` into `packages/`.
  - Line 3 gives "918 files, 25 zones"; production TypeScript under `src` + `packages` is now about 2,000 files.
  - Lines 8-9 say a rendered viewer "was also built and dropped", but `tools/depgraph-view/` is tracked, tested by `depgraph:test` (`package.json:165`), and published to the site by `website/scripts/build-depgraph.mjs:20`.
  - Still cited as live by `scripts/layering/check.ts:266` ("tracks the count this rule ratchets") and `scripts/layering/type-inversion-ratchet.ts:3,12`.
- Fix: delete the file and repoint the two script comments at the ratchet itself, or cut it to the still-true "what the gate guarantees" section and remove the per-file tables and the viewer sentence.
- Effort: S
- Model: sonnet
- Verify: `git grep -n dependency-graph-findings` shows no dangling citation; `pnpm check:layering`.

### DOCS-9: The provider-integration suite runs twice per CI run
- Category: inefficient
- Severity: medium     Confidence: medium (duplicate is certain; cost in minutes not measured)
- Evidence:
  - `package.json` `test:coverage:ci` = `vitest run --coverage --allowOnly=false --project=!fuzz-worker`, which includes the `provider-integration` project (`vitest.config.ts`, 102 files under `test/integration/provider-scenarios/`). `ci.yml:280-308` runs it as gate `unit-ci` and says so ("full unit + provider-integration suites under coverage").
  - `ci.yml:391-393` runs gate `provider-integration` (`test:integration:provider`, the same project) again in the Integration job.
- Fix: drop the `provider-integration` step from the Integration job (the Coverage job already fails on a red test), or exclude the project from the instrumented run if its coverage is not wanted. Update `scripts/check-affected/checks.ts` ownership and `docs/agents/testing.md` ("GitHub owns ... provider integration") to match.
- Effort: S
- Model: opus (gate-manifest ownership rules)
- Verify: `pnpm check:gate-manifest`; compare Coverage/Integration job durations before and after.

### DOCS-10: Smoke tests run two or three times in a local full check; fixture-cache runs twice in CI
- Category: inefficient
- Severity: low     Confidence: high
- Evidence:
  - `check:unit` = `test:unit && check:tmpdir-leaks && test:smoke`; `test:smoke` globs `test/integration/smoke-*.test.ts` (17 files). `test:integration:node` globs `test/integration/*.test.ts`, a superset. `pnpm check` selects both gates `unit` and `integration-node` (`scripts/check-affected/checks.ts:66,80`), and gate `macos-coverage` runs `smoke-macos-coverage.test.ts` a third time.
  - `test/scripts/setup-fixture-app-fallback-smoke.sh:19` runs `pnpm test:fixture-cache`; `ci.yml:402-409` runs gate `fixture-fallback` and then gate `fixture-cache`, so the 757-line `test/ci/trusted-fixture-artifact.test.mjs` runs twice in the Integration job and twice in `pnpm check`.
- Fix: remove `&& pnpm test:smoke` from `check:unit` (or exclude `smoke-*` from the `integration-node` glob), and remove line 19 from the shell script. Adjust the `CONTRIBUTING.md:219-223` description of `pnpm check`.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:gate-manifest`; `pnpm test:fixture-fallback`.

### DOCS-11: Website source is never typechecked by any gate; three TypeScript majors in one repo
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `website/package.json` has `"check": "astro check"` with `@astrojs/check` and `typescript ~5.9.2` devDependencies, but no workflow, gate, or root script calls it (`git grep` for `website` in `.github`, `package.json`, `scripts/check-affected`, `scripts/gate` finds only the `build`). `check:doc-links` runs `astro build`, which does not typecheck.
  - Untyped surface: `website/src/site/content.ts` (663 lines), `website/src/components/site/dither.ts` (431), `routeData.ts`, 8 other `.ts` files and the `.astro` frontmatter.
  - TypeScript versions: root `^7.0.2`, `website` `~5.9.2`, `examples/test-app` `~6.0.3`.
- Fix: add `pnpm --dir website check` to the `docs-links` gate script (it already installs and builds the site), or remove the script and the two devDependencies. Decide whether `website` can share the root TypeScript.
- Effort: S
- Model: sonnet
- Verify: `pnpm --dir website check` exits 0 in the Docs workflow.

### DOCS-12: Thirteen `docs/evidence` reports are referenced by nothing
- Category: unneeded
- Severity: low     Confidence: high (unreferenced), medium (safe to delete)
- Evidence: basename and date-less stem searched across the whole repo with zero hits outside the file itself for: `ios-simulator-ax-bridge-2026-09-02-corrected.md`, `android-long-scroll-2026-10-19.md`, `ios-text-daemon-latency-2026-10-19.md`, `android-automation-performance-2026-10-19.md` (+ `-base.json`, `-change.json`), `ios-boot-build-overlap-2026-10-19.md`, `android-smoke-helper-preflight-2026-10-19.md`, `ios-simulator-snapshot-source-2026-09-04.md`, `install-timeout-ledger-2026-10-30.md`, `ios-smoke-contracts-2026-10-17.md`, `ios-runner-listener-auth-2026-10-10.md`, `surface-geometry-4189-2026-11-03.md`. A further 17 files are referenced only by a sibling evidence file. Only 7 evidence files are cited from an ADR, agent doc, or code. `docs/adr/FORMAT.md` sends experiment logs to "the issue that ran the experiment".
  - Several cite paths that never existed here or are gone: `docs/evidence/ios-e2e-engine-pr1236-2026-10-19.md:110` (`packages/ios/bench/bench.ts`), `android-e2e-parity-2026-10-19.md:46` and `android-readiness-2026-10-19.md:32` (`tests/fixtures.ts`), `ios-text-daemon-latency-2026-10-19.md:27` (`packages/platform-apple/src/system-surface-presence.ts`).
- Fix: move the unreferenced reports into their issues/PRs and delete them (about 150 KB of the 468 KB directory), or add a one-line index in `docs/evidence/` that ties each kept file to the ADR or gate it supports.
- Effort: S
- Model: sonnet
- Verify: for each kept file, `git grep -lF <basename> -- . ':!docs/evidence'` is non-empty.

### DOCS-13: `examples/README.md` and `examples/sdk/tsconfig.json` lag the SDK surface
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `examples/README.md:30-36` lists five examples; `examples/sdk/host-runtime.ts` (`startAgentDevice`) is the sixth and is registered in `.fallowrc.json:50` but not in the table. The README's list of exercised subpaths also stops at five.
  - `examples/sdk/tsconfig.json:7-18` maps 12 subpaths; `package.json` `exports` has 15 (`./limrun`, `./plugins`, `./plugins/webdriver` are missing), although the file comment says the map mirrors the published export map.
  - `test/repo-guards/client-api-examples-drift.test.ts:37-43` requires only five symbols, so `startAgentDevice` can lose its example unnoticed.
- Fix: add the `host-runtime.ts` row, add the three `paths` entries, and add `{ subpath: 'agent-device', symbol: 'startAgentDevice' }` to `REQUIRED_EXAMPLE_SYMBOLS`.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; `pnpm exec vitest run --project unit-core test/repo-guards/client-api-examples-drift.test.ts`.

### DOCS-14: `skills/agent-device/SKILL.md` description omits web, Linux, and webOS targets
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `skills/agent-device/SKILL.md:3` lists Apple platforms, Android, HarmonyOS, and Vega only. `package.json:4` and `README.md:16` say "mobile, web, TV, and desktop apps"; `packages/platform-web`, `packages/platform-linux`, and `packages/provider-webos` exist, and the website has `webos.md` and web sections. The description is the trigger text an agent host matches on, so a web or Linux task does not select the skill.
- Fix: add web sessions, Linux desktop, and webOS TV to the description; check `scripts/__tests__/simulator-skills-contract.test.ts` and `agent-setup-startup-contract.test.ts` for a pinned string.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:agent-guidance`; `pnpm exec vitest run --project unit-core scripts/__tests__/simulator-skills-contract.test.ts`.

### DOCS-15: Six per-platform coverage smoke tests repeat the same three test bodies
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: "coverage declarations cover exactly the public catalog with an assertion and owner" and "contract declarations name an existing file containing the evidence test text" are re-implemented inline in `test/integration/smoke-{android-emulator,ios-simulator,linux,macos,tvos-platform,web-platform}-coverage.test.ts` (e.g. `smoke-tvos-platform-coverage.test.ts:25-59`, `smoke-linux-coverage.test.ts:27-39,103-114`, `smoke-web-platform-coverage.test.ts:24-36,62-77`). Only the gap-ownership and rollup checks were lifted into `test/integration/support/coverage-classification.ts`. The iOS file has no "classification summary is the rollup" test that the other five have, which is the kind of drift the copies allow.
- Fix: move the two loops into `coverage-classification.ts` as `assertCoverageCoversPublicCatalog` and `assertContractOwnersExist`; call them from each file; add the missing iOS rollup test or record why it is absent.
- Effort: S
- Model: sonnet
- Verify: `pnpm test:smoke`.

### DOCS-16: Stale comment cites a budget that `docs/agents/testing.md` does not contain
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `test/integration/client-api-doc-snippets.test.ts:19-21` — "exceeds the unit suite's 2.5s slow-test budget (see docs/agents/testing.md)". `docs/agents/testing.md` has no mention of a slow-test budget; the value lives in `scripts/vitest-slow-test-reporter.ts:14` (`UNIT_BUDGET_MS = 2_500`) and the rule in `docs/agents/test-authoring.md` ("Slow-test pins only shrink").
- Fix: point the comment at `scripts/vitest-slow-test-reporter.ts`.
- Effort: S
- Model: sonnet
- Verify: none needed beyond `pnpm format:check`.
