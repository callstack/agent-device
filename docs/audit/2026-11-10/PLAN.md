# Repository audit and remediation plan (2026-11-10)

Base commit: `093341a`. Scope: every tracked directory. Method: 29 read-only audit passes over 14 slices, plus the repository gates run once at the base commit.

Result: 548 findings. 177 broken, 188 inconsistent, 82 inefficient, 101 unneeded. 7 high, 167 medium, 374 low. Suggested owner: 136 opus, 412 sonnet.

Each finding has an ID, evidence (`path:line`), a fix, an effort, and a verify command in [`findings/`](findings/). The [index](#full-index) lists all of them.

## Limits of this audit

- Most findings come from reading code. They were not run on a device, a Mac, or Xcode. Treat each one as a hypothesis until the executor reproduces it.
- The lead reproduced or confirmed 5 findings directly: SRC-4, DSRV-4, TEST2-1, CONTR-1 (redirect path), TOOL-3.
- Coverage is not 100%. Production code read line by line: daemon ~95%; platform-apple ~75%; platform-android ~80%; providers and minor platforms ~85%; capture-kit ~70%; contracts ~60%; command packages ~65%; maestro/replay/react-native ~75%; root `src/` ~65%; scripts ~50%; native Swift/ObjC ~60%. Test bodies were mostly scanned mechanically (~5-10% read). Each report has a `Coverage` section that names the unread files.
- Known duplicates: DCORE-1 = DSESS-3. TOOL-5 = DOCS-9. ARUN-20 = APPLE-1. SRC-9 overlaps TOOL-6.

## Gate baseline at `093341a`

| Gate | Result |
| --- | --- |
| `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check` | pass |
| `pnpm check:layering`, `check:fallow`, `check:production-exports`, `check:mcp-metadata`, `check:doc-links` | pass |
| `pnpm audit --prod` | no known vulnerabilities |
| `pnpm test:unit` | 17,641 pass, 7 fail, 75 skipped (see BASE-1) |
| `fallow --summary` (no baseline) | 35 dead-code issues, 25 clone groups, 22 functions above the complexity threshold (see BASE-2) |

Findings from the gate run:

- **BASE-1** (sonnet, S): 7 unit tests fail when the suite runs as uid 0. They use `chmod` to force a read or write failure, and root ignores it. Files: `packages/daemon-contracts/src/device-claims-app.test.ts`, `packages/capture-kit/src/durable-capture/adoption.test.ts`, `packages/capture-kit/src/capture-admission/__tests__/durable-capture-resource.test.ts`, `packages/daemon/src/resources/__tests__/app-log-session-resource.test.ts`, `packages/daemon/src/server/http/daemon-session-idle-expiry.test.ts`. Sibling tests use `test.skipIf(process.getuid?.() === 0)`. Apply the same guard, or inject the failure through the existing seam.
- **BASE-2** (sonnet, S): `fallow dead-code` lists 1 unused file (`scripts/vitest-apple-runner-home-setup.ts`), 9 unused exports, 14 unused type re-exports (10 in `packages/maestro/src/index.ts`), 1 unused class member (`LimrunRuntime.installInstallablePath`), `@types/json-schema` unused, `oxc-parser` used in production but declared as a dev dependency, and two unused overrides (`react-router`, `react-router-dom` in `pnpm-workspace.yaml`). Run `npx fallow dead-code` for the list. Remove each item or prove the reference.
- **BASE-3** (sonnet, S): GitHub Actions majors are behind (`actions/checkout` 6→7, `upload-artifact` 4→7, `download-artifact` 4→8, `setup-node` 6→7, `setup-java` 4→6, `pnpm/action-setup` 4→6, `gradle/actions` 4→6). `pnpm outdated -r` prints the list. See TOOL-26.

## Rules for executors

1. Read `AGENTS.md` and the row of its routing table that matches the work package.
2. Take one work package. Open the cited finding in `findings/`. Reproduce it first with a failing test or a command. If it does not reproduce, record that in the PR and drop it.
3. Fix at the owning module. Do not add compatibility or fallback paths. Remove superseded paths in the same change.
4. Use typed reasons. Do not match error text.
5. A device-facing change needs the evidence that `docs/agents/device-verification.md` requires. This container has no devices or Xcode; those packages need a Mac host.
6. Run `pnpm check:affected --run` before you push. Use one PR per work package. Keep PRs small enough to review.
7. Opus packages that change a contract or merge two implementations start with a short design note in the PR description, then the code.

Model assignment:

- **Opus**: concurrency, lifecycle, security, cross-package contracts, device behavior, merging duplicate implementations, and any "is this still needed?" decision.
- **Sonnet**: local, mechanical, well-specified fixes with a clear test; deletions after opus (or the maintainer) confirmed the decision.

## Phase 1 — security and data loss (do first)

| WP | Model | Findings | Goal |
| --- | --- | --- | --- |
| S1 | sonnet | CONTR-1 | Upload client must not follow a redirect to another origin with the daemon bearer token. |
| S2 | opus | CONTR-4, CONTR2-4 | Client chooses artifact write paths, not the remote daemon. Launcher creates state dir and `daemon.log` with `0o700`/`0o600`. |
| S3 | sonnet | DSRV-3, DSRV-4, DSRV-6 | Cap pre-auth socket input. Reject empty integer env values. Verify `x-artifact-hash` on legacy `/upload`. |
| S4 | opus | DSRV-5, CONTR-2, CMD-5 | One consistent timeout budget for large uploads and installs across client, proxy, and daemon. |
| S5 | opus | ANDR-3 | Authenticate the Android helper loopback session and add a read timeout. |
| S6 | opus | PROV-3 | Keep typed text out of child argv and error details for web `fill`/`type`. |
| S7 | sonnet | SRC2-4, CAP-3 | App-log redaction must not drop patterns silently. Redaction must not mark repeated references as `[Circular]`. |
| S8 | opus | DCORE-1 (=DSESS-3), SRC2-5, APPLE-4 | No success report when a script save fails, when a lease release fails, or before a replacement artifact is validated. |

## Phase 2 — correctness, by owner

| WP | Model | Findings | Goal |
| --- | --- | --- | --- |
| C1 | sonnet | SRC-1, SRC-4, SRC-5, SRC-7 | MCP stdin decoder survives blank/malformed lines. `AGENT_DEVICE_PLATFORM` uses the real platform list. `test` exits through the flushed path. `mcp` rejects stray args. |
| C2 | opus | SRC-2, SRC-3 | MCP handles `ping` and cancellation during a tool call. One session-lock policy for CLI, MCP, and AI SDK. |
| C3 | sonnet | DEXEC-1, DEXEC-2, DEXEC-3, DEXEC-7, DSESS-1, DSESS-4, CMD2-1, DCORE-4 | Daemon command input bugs: `type` text that starts with `@`, ref frame expiry on a rejected `type`, `trigger-app-event` template, `alert` subactions, inline `push` JSON, cwd for relative paths, `clipboard write ""`, recorded empty `fill`. |
| C4 | opus | DSRV-1, DSRV-2, DCORE-2, DSESS-2, DSESS-7 | Daemon lifecycle: diagnostics outside a scope, uncancelled teardown timer, late `bindDevice` cleanup, suite session lease release, required dependencies typed as optional. |
| C5 | opus | ANDR-2, ANDR2-1, ANDR2-2, ANDR2-3, ANDR-4, ANDR-5, ANDR-6 | Android: IME commit verification, `record stop` after pid reuse, IME probe failure handling, one foreground-app reader, warm-session fallbacks. Sonnet takes ANDR-1 (`%s` in `input text`). |
| C6 | opus | APPLE2-1, APPLE2-6, APPLE2-7, APPLE-3, ARUN-1, ARUN3-2, ARUN3-3 | Apple: socket `error` listener, iPad launch confirmation, macOS perf bundle match, Booted memo expiry, macOS alert button choice, `defer` skipped by `NSException`, snapshot-bridge read deadline. Sonnet takes ARUN-2, ARUN-3, ARUN-4, APPLE2-2, APPLE2-3, APPLE2-5. |
| C7 | opus | REPLAY-1, REPLAY-2, REPLAY-6, REPLAY-8, REPLAY2-2, REPLAY2-4 | Replay and Maestro: `${...}` escaping on record, `runScript` off the event loop, `launchApp.arguments`, bounded `repeat while`, ref scope of divergence suggestions, companion tunnel race. Sonnet takes REPLAY-3, REPLAY-4, REPLAY-7, REPLAY2-3. |
| C8 | opus | PROV2-1, PROV2-2, PROV2-3, PROV-5, PROV-10, CONTR3-1 | Providers: WebDriver Android `home`/`appSwitcher`, `activateApp` args, HarmonyOS recorder toggle, ydotool v1 calls, leaked billed session on delete failure, `open --relaunch` dropped on four platforms. Sonnet takes PROV-1, PROV-4, PROV-6, PROV-7, PROV-8, PROV-9, PROV-11. |
| C9 | sonnet | CAP-4, CAP2-1, CAP2-6, CONTR2-2, CONTR-3, CONTR3-2, CMD-2 | Small verified logic errors in capture-kit, contracts, proxy, and command-runtime. Opus takes CAP2-2, CAP2-4, CMD-4. |

## Phase 3 — cross-cutting consolidation (opus designs, sonnet follows)

| WP | Model | Findings | Goal |
| --- | --- | --- | --- |
| X1 | opus | CONTR2-1, SRC2-2, PROV2-5, CMD-3, APPLE2-4, ARUN2-1 | One async, cached process-identity reader in `host-kit`. No synchronous `ps` on the daemon event loop. Every signal checks process identity first. |
| X2 | opus | CMD-6, ARUN2-5 | One TERM-then-KILL escalation with real grace periods. |
| X3 | opus | APPLE-10, CMD2-2, REPLAY2-1, CAP3-3, CONTR3-3 | Replace error-text matching with typed reasons. Then sonnet extends the guard (TEST2-1) to `packages/*/src` and fixes the 4 sites it finds. |
| X4 | opus | APPLE-1, ARUN-5, ARUN2-3, APPLE-12, ANDR-8, APPLE-7, APPLE-8 | Helper, runner, and toolchain fingerprints computed once per daemon with single-flight builds. One `Info.plist` reader. |
| X5 | opus | PROV-2, SRC2-6 | One provider lease state machine (`provision-kit` lease table) with one refusal vocabulary. |
| X6 | opus | APPLE-5, APPLE-6 | One simulator boot implementation. Default timeout on every `simctl` and host spawn. |
| X7 | opus | ARUN2-2, CAP-9 | Swift direct-selector matching equals `@agent-device/selectors`. One `details.ref` format. Sonnet takes CAP-12. |
| X8 | opus | DCORE-5 | Finish the `captureSnapshot` migration and delete the legacy interactor capture fallback. |

## Phase 4 — performance

| WP | Model | Findings | Goal |
| --- | --- | --- | --- |
| P1 | sonnet | CAP-1, CAP-2, CAP-6, CAP2-3, CAP3-4, CMD2-8 | Remove quadratic passes over snapshot nodes. Add a benchmark or a node-count test for each. |
| P2 | opus | CAP-5, CAP2-5, CAP3-5, ANDR-7 | Occlusion scan cost, image work off the event loop, single parse of helper XML. |
| P3 | opus | ARUN-6, ARUN-7, ARUN3-1, ARUN3-5 | Batch AX and XCTest attribute reads in the runner and macOS helper. Needs a Mac and a device run. |
| P4 | sonnet | APPLE-2, APPLE-11, ANDR2-12, DSESS-6, DEXEC-4 | Bound and parallelize inventory work. No device resolution for a pure sleep. |
| P5 | opus | DEXEC-5, DEXEC-6, SRC2-1, SRC2-3, SRC-6, APPLE-9, PROV2-4 | Per-command overhead: extra snapshot while recording, tar on artifact list, per-process adb scans, app-log rotation, extra token refresh, `devicectl` triple spawn, page-source read before each scroll. |

## Phase 5 — removal

Opus confirms each "unused" claim against dynamic references and public API, then sonnet deletes.

| WP | Model | Findings | Goal |
| --- | --- | --- | --- |
| R1 | opus → sonnet | CMD-1, CMD2-3 | Remove command-runtime families and interaction commands that have no production caller (~2.8k lines), or wire them. |
| R2 | sonnet | REPLAY-5, CONTR3-4, CONTR3-5, ANDR2-8, ANDR2-9, ANDR2-10, TOOL-6, BASE-2 | Remove unset fields, the retired `--update` flag, dead duplicate modules, the 127-name barrel, dead tsdown chunk groups, and the fallow list. |
| R3 | opus | DOCS-1, TOOL2-3 | Decide: give the recording E2E tests and the full replay suites an automatic lane, or delete them. |
| R4 | sonnet | TOOL-3, DOCS-8, DOCS-12, ARUN2-4 | Remove `.changeset/` files that no tool reads, the stale dependency-graph doc, unreferenced evidence reports, and `[DEBUG-1874]` logging. Confirm TOOL-3 with the maintainer first. |

## Phase 6 — gates, CI, and docs

| WP | Model | Findings | Goal |
| --- | --- | --- | --- |
| G1 | opus | TOOL-1, TOOL-4 | Type-check `scripts/` (358 files, ~190 errors). Make `pnpm check` run what CI runs. |
| G2 | sonnet | TOOL-2, TOOL2-4, TOOL-7, TEST2-2, TEST2-3, TEST2-5, CONTR2-3, DOCS-2, DOCS-5, BASE-1 | Gates that cannot fail: stale export lists, swallowed `git diff` failure, one-direction evidence checks, self-skipping loopback tests, spent output-economy waivers, uncompiled doc snippets, root-uid tests. |
| G3 | opus | TEST2-4 | Apple `simctl` fakes must throw on unmodeled commands. |
| G4 | sonnet | TOOL-5 (=DOCS-9), DOCS-10, TOOL2-2, TOOL2-5, BASE-3 | CI: run provider-integration once, drop duplicate smoke runs, rotate torture seeds, one Android SDK install action, update action majors. |
| G5 | opus | TOOL2-1 | `build-xcuitest-apple.sh` cleans the right directory and never `rm -rf`s an override path. |
| G6 | opus | DOCS-3, DOCS-4, DOCS-7 | ADR status and content match the code. Sonnet takes DOCS-6, DOCS-11, DOCS-13, DOCS-14, DOCS-15, DOCS-16. |

## Phase 7 — the low-severity tail

All findings not named above are low severity. Work them one report at a time. For each report in the index, sonnet takes the rows marked `sonnet` as one PR per package, and opus takes the rows marked `opus`. Skip rows already closed by a work package above.

## Order and parallelism

- Phase 1 first. S1, S3, S7 can run in parallel with C1 and BASE-1.
- X1 before P5 and C5 (shared process-identity code). X3 before the TEST2-1 guard extension. X4 before P3.
- R1 and R3 need a maintainer decision before deletion.
- Give parallel workers different packages. `pnpm check:affected --run` and `pnpm check` share one lock.

## Full index

### [apple-runner-native-2.md](findings/apple-runner-native-2.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| ARUN2-1 | Local runner disposal signals `child.pid` without checking that the child is still that process | broken | medium | medium | S | opus |
| ARUN2-2 | The Swift direct-selector path does not match the way `packages/selectors` does | inconsistent | medium | high | M | opus |
| ARUN2-3 | A runner cache hit hashes every product file twice, synchronously | inefficient | medium | high | M | opus |
| ARUN2-4 | `[DEBUG-1874]` investigation logging still ships in the runner | unneeded | low | high | S | sonnet |
| ARUN2-5 | Three kill ladders send their signals back to back, so the gentle rungs do nothing | inconsistent | low | high | S | opus |
| ARUN2-6 | The cache lock and cache eviction spawn `ps` synchronously where the lease code uses a cached value | inefficient | low | high | S | sonnet |
| ARUN2-7 | The session `.json` plist intermediate holds the listener token for the whole session and is tracked through four types | unneeded | low | medium | S | sonnet |
| ARUN2-8 | Platform-hint scoring in `findXctestrun` cannot change the result in the keyed cache layout | unneeded | low | medium | S | sonnet |
| ARUN2-9 | `packageVersion` is written to the cache metadata and never read | unneeded | low | high | S | sonnet |
| ARUN2-10 | A manifest read failure is reported as `file_too_large` | inconsistent | low | high | S | sonnet |
| ARUN2-11 | Orphaned doc block in `runner-lease.ts` | inconsistent | low | high | S | sonnet |

### [apple-runner-native-3.md](findings/apple-runner-native-3.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| ARUN3-1 | `keyboard enter` with nothing focused reads every element of the app one attribute at a time | broken | medium | high | S | sonnet |
| ARUN3-2 | Three error paths raise an `NSException` from Swift, which skips the `defer` that restores `waitForIdleTimeout` | broken | medium | medium | S | opus |
| ARUN3-3 | The runner-hosted snapshot-bridge reader has no deadline, so an abandoned read keeps issuing accessibility requests | broken | medium | high | S | opus |
| ARUN3-4 | The text-input point probe falls back to a live `element.frame` read, outside issue containment on two of its three routes | broken | medium | medium | S | opus |
| ARUN3-5 | Keyboard return and dismiss lookups issue one XCTest query per label and per container | inefficient | medium | high | S | sonnet |
| ARUN3-6 | A selector tap on a text input that never reports keyboard focus polls for 4 s and taps the field a second time | inefficient | low | medium | M | opus |
| ARUN3-7 | `RunnerResolveWindowDisplayID` reads a window's frame without the existence check its own file requires | inconsistent | low | medium | S | sonnet |
| ARUN3-8 | `RunnerCopyLitPanelWindows` has no window cap and runs again for every element query of a lit-panel request | inconsistent | low | high | S | opus |
| ARUN3-9 | The XCTest coordinate-drag path resolves the window, the app frame and the keyboard two to three times | inefficient | low | high | S | sonnet |
| ARUN3-10 | Alert title and system-modal reads sit outside the deadline and exception containment the rest of the alert path uses | inconsistent | low | medium | S | sonnet |
| ARUN3-11 | Two refusals on the `fill` and `swipe` paths carry no code, and one is sent after a tap was dispatched | inconsistent | low | high | S | sonnet |
| ARUN3-12 | `nodeFromSnapshot` keeps a second depth and node bound that the tree reader already enforces, and its early `break` would drop siblings | unneeded | low | medium | S | sonnet |
| ARUN3-13 | `ModalSurface` and `ModalScopePair` ship in the runner library with no production caller | unneeded | low | low | S | sonnet |
| ARUN3-14 | Small leftovers | unneeded | low | high | S | sonnet |

### [apple-runner-native.md](findings/apple-runner-native.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| ARUN-1 | macOS helper `alert accept/dismiss` picks buttons by substring and by position, so it can press the opposite button | broken | medium | high | M | opus |
| ARUN-2 | macOS helper snapshot attributes a wrong `windowTitle` to every element under an untitled window | broken | medium | high | S | sonnet |
| ARUN-3 | macOS helper depth cap is silent on `frontmost-app`, `desktop` and `menubar` | inconsistent | medium | high | S | sonnet |
| ARUN-4 | Runner non-inline screenshots are never deleted | broken | medium | high | S | sonnet |
| ARUN-5 | Every local runner command re-walks the runner source tree and re-reads Xcode version files synchronously | inefficient | medium | high | S | opus |
| ARUN-6 | macOS helper snapshot makes about 11 AX round trips per node and a quadratic visited check | inefficient | medium | high | M | opus |
| ARUN-7 | XCTest query-sweep tier and `querySelector` read live elements one attribute at a time | inefficient | medium | medium | M | opus |
| ARUN-20 | every macOS helper call re-fingerprints the helper sources and spawns `swift --version` | inefficient | medium | high | S | sonnet |
| ARUN-8 | `aggregatedLabel` re-walks up to four levels of descendants for every unlabeled node | inefficient | low | medium | M | sonnet |
| ARUN-9 | Host classifies the runner watchdog timeout by matching Swift error text | inconsistent | low | high | S | sonnet |
| ARUN-10 | Runner argument-validation refusals are typed for some commands and untyped for others | inconsistent | low | high | S | sonnet |
| ARUN-11 | macOS helper argument parsing breaks on text equal to a flag and silently defaults bad integers | broken | low | high | S | sonnet |
| ARUN-12 | One-sided wire fields | unneeded | low | high | S | sonnet |
| ARUN-13 | `gestureViewport` returns width and height in fields named `x2` and `y2` | inconsistent | low | high | S | sonnet |
| ARUN-14 | `RUNNER_PROTOCOL.md` points at the wrong files and the wrong declaration site | inconsistent | low | high | S | sonnet |
| ARUN-15 | Dead dispatch branches and a trait mismatch for commands the transport answers off-queue | unneeded | low | high | S | sonnet |
| ARUN-16 | Swift symbols that only tests reference | unneeded | low | high | S | sonnet |
| ARUN-17 | Every runner-reported error carries a fabricated `xcodebuild` detail | unneeded | low | medium | S | sonnet |
| ARUN-18 | Checkout runner fingerprint includes files that cannot change the production runner | inefficient | low | medium | S | sonnet |
| ARUN-19 | Comments on the two sides disagree about whether a replayed response is stamped | inconsistent | low | high | S | sonnet |
| ARUN-21 | Legacy `XCTestDevices` redirect restore still ships as public surface | unneeded | low | low | S | opus |

### [capture-selectors-kernel-2.md](findings/capture-selectors-kernel-2.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| CAP2-1 | `captureScrollEdgeState` turns every failure, including cancellation, into a generic `COMMAND_FAILED` | broken | medium | high | S | sonnet |
| CAP2-2 | PID-scoped app-log capture stops for good after one failed PID poll | broken | medium | medium | S | opus |
| CAP2-3 | Screenshot overlay label resolution is quadratic and walks parents without a cycle guard | inefficient | medium | high | S | sonnet |
| CAP2-4 | Provider app-log poller ends permanently on one slow read, and `finish` cannot interrupt a read or a sleep | inconsistent | medium | medium | S | opus |
| CAP2-5 | Diff region analysis and image resize run on the daemon event loop, next to a comment that says the CPU work is on the worker | inefficient | medium | medium | M | sonnet |
| CAP2-6 | `mergeNetworkScans` returns more entries than `maxEntries` | broken | low | high | S | sonnet |
| CAP2-7 | The PID monitor spawns a `pidof` process twice a second for the life of every app-log stream | inefficient | low | medium | S | opus |
| CAP2-8 | Audio probe `finish` overwrites the helper's own stop time and reason | inconsistent | low | medium | S | sonnet |
| CAP2-9 | Scroll edge analysis has no reuse: each caller pays normalize, hints, visibility index, and fingerprint to read one field | inefficient | low | high | S | sonnet |
| CAP2-10 | `ScreenshotDiffResult` keeps two fields and two types that nothing emits | unneeded | low | high | S | sonnet |
| CAP2-11 | Failed-adoption recovery writes the durable record outside the fence that claims to be the only writer | inconsistent | low | high | M | opus |
| CAP2-12 | `kernel/device.ts` documents the pre-collapse platform model and keeps leaf-string paths that no producer feeds | inconsistent | low | high | S | opus |
| CAP2-13 | Daemon enum tuples exist once privately in kernel and again as literals in two other packages | inconsistent | low | high | S | sonnet |
| CAP2-14 | Four PNG header readers with different trust rules, and a pixel-budget error that prints the wrong reason | inconsistent | low | high | S | sonnet |
| CAP2-15 | Full-image crop decodes the whole PNG to answer "no crop needed" | inefficient | low | high | S | sonnet |
| CAP2-16 | `readVideoContainerKind` says it sniffs bytes and dispatches on the file name; the MP4 check opens the file twice | inconsistent | low | high | S | sonnet |
| CAP2-17 | Recording helper scripts can resolve from the current working directory | unneeded | low | medium | S | sonnet |
| CAP2-18 | Two copies of the diff-region accumulator, and a nearby-merge that is not transitive | inconsistent | low | high | S | sonnet |

### [capture-selectors-kernel-3.md](findings/capture-selectors-kernel-3.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| CAP3-1 | React Native overlay hint fires for any label that starts with "Error:" or "Warning:", on every platform | broken | medium | high | S | opus |
| CAP3-2 | The per-record recovery deadline bounds only the acquisition; the cleanup that follows has no bound and daemon startup awaits it | broken | medium | medium | M | opus |
| CAP3-3 | `alert wait` times out with no typed reason, while every other alert refusal has one | inconsistent | medium | high | S | sonnet |
| CAP3-4 | Runner snapshot presentation validates the same node list twice for every non-interactive regular capture | inefficient | medium | high | S | sonnet |
| CAP3-5 | Contact-sheet selection and rendering run synchronously on the daemon event loop | inefficient | low | medium | S | sonnet |
| CAP3-6 | `scroll-edge-state/selection.ts` contains raw NUL bytes, so grep-based tools treat it as binary | broken | low | high | S | sonnet |
| CAP3-7 | A replayed `record stop` checks that the main output file exists, but not the chunk files it also serves | broken | low | medium | S | sonnet |
| CAP3-8 | The interactive presentation rules rebuild the same indexes and walk ancestors for every `Other` node | inefficient | low | high | S | sonnet |
| CAP3-9 | `parentClipLookups` and its callback plumbing have no reader | unneeded | low | high | S | sonnet |
| CAP3-10 | Engine constants and helpers that must agree are written twice, with dead branches | inconsistent | low | high | S | sonnet |
| CAP3-11 | The `perf` request parser reads `kind` from a positional for cpu and trace, names `--kind` in its error, and accepts trailing tokens | inconsistent | low | medium | S | sonnet |
| CAP3-12 | A screen-recording start scans every session directory twice with sync I/O and reads its own record three times | inefficient | low | high | S | sonnet |
| CAP3-13 | Contact-sheet cells report a change ratio measured against a cell the sheet no longer shows | inconsistent | low | high | S | sonnet |
| CAP3-14 | Two `isDescendantOf` walks in selectors, both run once per snapshot node | inconsistent | low | high | S | sonnet |
| CAP3-15 | Point targets parse with `Number()`, so an empty string is coordinate 0 and extra tokens are ignored | broken | low | medium | S | sonnet |
| CAP3-16 | Small drift in capture-admission and snapshot-freshness | inconsistent | low | high | S | sonnet |
| CAP3-17 | One test in the two packages has no assertion | broken | low | high | S | sonnet |

### [capture-selectors-kernel.md](findings/capture-selectors-kernel.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| CAP-1 | Android helper presentation rescans the whole node array for every descendant | inefficient | medium | high | S | sonnet |
| CAP-2 | Snapshot diff copies a Map per edit step, so cost is quadratic in the edit distance | inefficient | medium | high | M | sonnet |
| CAP-3 | Redaction reports any repeated object reference as `[Circular]` | broken | medium | high | S | sonnet |
| CAP-4 | Keyboard frame guard claims to equal `isPositiveFiniteRect` but skips two of its three refusals | broken | medium | high | S | sonnet |
| CAP-5 | Occlusion scan repeats classification and ancestor walks for every target-overlay pair | inefficient | medium | medium | M | opus |
| CAP-6 | One settle classifies keyboard and system chrome on the same nodes up to three times | inefficient | medium | high | S | sonnet |
| CAP-9 | `details.ref` is bare on some refusal reasons and `@`-prefixed on others | inconsistent | medium | high | M | opus |
| CAP-7 | The post-gesture surface cache never hits, so every poll's signature is computed twice | inefficient | low | high | S | sonnet |
| CAP-8 | `isRequestCanceledError` falls back to matching the error message | inconsistent | low | high | S | sonnet |
| CAP-10 | A daemon test fake re-implements selector parsing and matching | inconsistent | low | high | S | sonnet |
| CAP-11 | `ROLE_HINT_WORDS` cites a moved table and has drifted from it | inconsistent | low | high | S | sonnet |
| CAP-12 | The no-match hint says values "match exactly"; matching ignores case and collapses whitespace | inconsistent | low | high | S | sonnet |
| CAP-13 | Two "semantic touch target" role lists disagree | inconsistent | low | medium | M | opus |
| CAP-14 | `find` argument parsing silently drops an invalid wait timeout and trailing tokens | broken | low | medium | S | sonnet |
| CAP-15 | Enum-set flags accept a different boolean vocabulary than boolean flags | inconsistent | low | high | S | sonnet |
| CAP-16 | `formatSnapshotLine`'s `hiddenGroup` parameter is never true in production | unneeded | low | high | S | sonnet |
| CAP-17 | Package subpath exports with no consumer outside their own package | unneeded | low | high | S | sonnet |
| CAP-18 | Nine "Mutation-lane note" comment blocks keep guards the notes call provably redundant | unneeded | low | high | S | sonnet |
| CAP-19 | `markNodeAndAncestorsVisible` walks to the root for every visible node | inefficient | low | high | S | sonnet |
| CAP-20 | Selector matching re-normalizes the query and re-derives role spellings for every node | inefficient | low | medium | S | sonnet |
| CAP-21 | capture-kit re-implements rect helpers that kernel already exports | inconsistent | low | high | M | sonnet |
| CAP-22 | The capture-kit package description does not describe the package | inconsistent | low | high | S | sonnet |
| CAP-23 | Small contract drift in `kernel/src/snapshot.ts` | inconsistent | low | high | S | sonnet |

### [command-packages-2.md](findings/command-packages-2.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| CMD2-1 | `clipboard write ""` is refused before it reaches the daemon, although docs and the daemon advertise it as "clear clipboard" | broken | medium | high | S | sonnet |
| CMD2-2 | Boot-failure classification is substring matching on error text and stdout, and it decides whether the Android boot wait keeps polling | broken | medium | medium | M | opus |
| CMD2-3 | Six bound interaction-runtime commands have no production caller | unneeded | medium | high | S-M | sonnet |
| CMD2-4 | The native-ref preflight judges `@ref` against the latest observation, not the authorized ref frame | inconsistent | low | medium | S | opus |
| CMD2-5 | `diff snapshot` compares against whatever capture last wrote the session snapshot, with no presentation check | inconsistent | low | medium | S | sonnet |
| CMD2-6 | `jsonSchemaField` advertises a schema and validates nothing, so six fields accept any value on the structured path | inconsistent | low | high | S | sonnet |
| CMD2-7 | Tar archives are read and decompressed twice; zip archives are opened three times | inefficient | low | high | M | opus |
| CMD2-8 | Snapshot text is always rendered, twice per line for `-i`, even when the caller prints JSON | inefficient | low | high | S-M | sonnet |
| CMD2-9 | Ref and find read failures disagree with the other read paths on message and typed reason | inconsistent | low | high | S | sonnet |
| CMD2-10 | Eleven `command-output-schemas-*.test.ts` files are the same two tests with one identifier changed | unneeded | low | high | S | sonnet |
| CMD2-11 | Merged-leaf warning prints `@undefined` for a node that has no ref | broken | low | medium | S | sonnet |
| CMD2-12 | The `snapshot` command hands the backend a different context than every other capture | inconsistent | low | medium | S | sonnet |
| CMD2-13 | Lease table can leave a ready rental with no holder when its only waiter is refused at delivery | broken | low | low | S | opus |
| CMD2-14 | `installArtifactArchiveBudget()` is typed `object \| undefined` and its only caller casts it | inconsistent | low | high | S | sonnet |
| CMD2-15 | `isTrustedInstallSourceUrl` is a deprecated export with no product caller | unneeded | low | high | S | sonnet |

### [command-packages.md](findings/command-packages.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| CMD-1 | Five command-runtime families are bound but never invoked in production | unneeded | medium | high | M | opus |
| CMD-2 | `isCommandTimeoutError` matches any `COMMAND_FAILED` carrying a numeric `timeoutMs` | broken | medium | high | S | sonnet |
| CMD-3 | Waiting on a process lock spawns the host process tool synchronously on every 100 ms poll | inefficient | medium | high | M | opus |
| CMD-4 | The process-lock reclaim mutex has no owner and no recovery path | broken | medium | medium | M | opus |
| CMD-5 | Install-source download has a fixed 120 s whole-transfer timeout against a 2 GiB cap | broken | medium | medium | S-M | sonnet |
| CMD-6 | host-kit has three TERM-then-KILL escalations that disagree; the reaper mislabels a kill timeout | inconsistent | medium | medium | M | opus |
| CMD-7 | `readProcessIdentityFacts` spawns `ps` three times per pid and does not leave the executor override | inefficient | low | high | S | sonnet |
| CMD-8 | `runCmdDetached` returns pid 0 on spawn failure and discards the error | broken | low | high | S | sonnet |
| CMD-9 | Graceful-kill escalation is cancelled when the direct child exits, so detached-group descendants never get SIGKILL | broken | low | medium | S | opus |
| CMD-10 | Device-resolution cache key omits `appleSimulatorAppTarget` and serializes the whole environment | inconsistent | low | medium | S | sonnet |
| CMD-11 | `snapshot --timeout` replaces the client envelope with no margin, and the derived daemon budget goes negative | inconsistent | low | high | S | sonnet |
| CMD-12 | `wait` positional numbers use loose `Number()`; `wait stable` silently drops garbage; `parseTimeout` exists three times | inconsistent | low | high | S | sonnet |
| CMD-13 | Human text output omits or mangles data the JSON output carries | inconsistent | low | high | S | sonnet |
| CMD-14 | `withSettledNotes` discards `jsonData` and `stderr` from the formatter it wraps | broken | low | high | S | sonnet |
| CMD-15 | host-kit helpers are re-implemented elsewhere and inside host-kit | inconsistent | low | high | M | sonnet |
| CMD-16 | Home-directory resolution contradicts itself inside host-kit | inconsistent | low | medium | S | opus |
| CMD-17 | `safeSessionName` is lossy, so distinct session names share one state directory | broken | low | low | S-M | opus |
| CMD-18 | `retryWithPolicy` reports `exhausted` with `attempt = maxAttempts` when it stopped early | inconsistent | low | high | S | sonnet |
| CMD-19 | `readHostCpuArch` caches a failed probe for the life of the process | broken | low | medium | S | sonnet |
| CMD-20 | `--on-error` is a flag whose only legal value is its default | unneeded | low | medium | S | sonnet |
| CMD-21 | Nineteen single-assertion registry tests restate descriptor literals against the constants the registry imports | unneeded | low | medium | S | sonnet |

### [contracts-clients-2.md](findings/contracts-clients-2.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| CONTR2-1 | Device-claim paths block the daemon event loop with repeated synchronous `ps` spawns | inefficient | medium | high | M | opus |
| CONTR2-2 | `events` paging gives a tailing reader no cursor to resume from, and the fallback arithmetic is wrong | broken | medium | high | S | sonnet |
| CONTR2-3 | 54 daemon-client tests self-skip through a raw loopback probe that bypasses the "loopback required" guard | broken | medium | high | S | sonnet |
| CONTR2-4 | The launcher creates the state dir and `daemon.log` with default permissions; the daemon's `0o600` never applies | broken | low | high | S | sonnet |
| CONTR2-5 | The journal re-spells contract vocabularies by hand, and its gesture list has already drifted | inconsistent | low | high | S | sonnet |
| CONTR2-6 | `findNearestAncestor` rebuilds the whole node map on every call; the overlay path calls it twice per node | inefficient | low | high | S | sonnet |
| CONTR2-7 | `device release --stale` refusal-reason table carries unreachable entries and mislabels an unreadable claim file | inconsistent | low | high | S | sonnet |
| CONTR2-8 | Daemon lifecycle `reason` strings are re-typed literals in two naming conventions, against the owner file's own rule | inconsistent | low | high | S | sonnet |
| CONTR2-9 | `apps.close` leaves Metro session hints that `sessions.close` clears | inconsistent | low | medium | S | sonnet |
| CONTR2-10 | Claim reconciliation builds the dead owner's session dir without the `..` guard its sibling uses | broken | low | medium | S | sonnet |
| CONTR2-11 | Event-log rotation: a failing rename drops every later event, and every read recounts the rotated generation | broken | low | medium | S | sonnet |
| CONTR2-12 | Launch spec still probes the superseded `dist/src/daemon.js` layout and keeps an unreachable throw | unneeded | low | medium | S | sonnet |
| CONTR2-13 | Second viewport-root predicate in the file that declares "one definition for the whole repo"; two ancestor walkers disagree | inconsistent | low | medium | S | opus |
| CONTR2-14 | Seven more tests that assert nothing at runtime (beyond the two files in CONTR-17) | broken | low | high | S | sonnet |
| CONTR2-15 | `releaseAfterRetirement` can turn a retirement result into a rejection through an unguarded diagnostic write | broken | low | medium | S | sonnet |
| CONTR2-16 | History-narrating comments in the daemon-client lifecycle and the tombstone reader (AGENTS.md comment rule; sites not listed in CONTR-16) | inconsistent | low | high | S | sonnet |

### [contracts-clients-3.md](findings/contracts-clients-3.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| CONTR3-1 | `open --relaunch` is silently dropped by the shared direct lifecycle binding (Linux, web, HarmonyOS, Vega) | broken | medium | medium | S-M | opus |
| CONTR3-2 | Serialized-summary readers accept values the types forbid, and `mergeSnapshotDiagnostics` allocates from an unvalidated `count` | broken | medium | medium | S | sonnet |
| CONTR3-3 | One invariant violation ("fact admitted, interactor member missing") has three error shapes | inconsistent | medium | high | S | sonnet |
| CONTR3-4 | `MAESTRO_NON_HITTABLE_FALLBACK_MESSAGE` has no consumer and is kept alive by a fallow allowlist entry | unneeded | low | high | S | sonnet |
| CONTR3-5 | The retired `--update` replay flag is still typed, parsed and sent on the wire, and nothing reads it | unneeded | low | medium | S | sonnet |
| CONTR3-6 | The `.ad` screenshot flag codec lives in contracts and is split with ad-script | inconsistent | low | high | M | sonnet |
| CONTR3-7 | Identical or re-spelled shapes inside contracts (not covered by CONTR-6 or CONTR-9) | inconsistent | low | high | S-M | sonnet |
| CONTR3-8 | Platform- and provider-specific mechanics inside the contracts package | inconsistent | low | high | M | opus |
| CONTR3-9 | Public client types for `settings` admit inputs the catalog always refuses | inconsistent | low | medium | S | sonnet |
| CONTR3-10 | Stale, orphaned and history-narrating comments (sites not listed in CONTR-16 or CONTR2-16) | inconsistent | low | high | S | sonnet |
| CONTR3-11 | Nine contracts modules import their own package by name while the rest use relative paths | inconsistent | low | high | S | sonnet |
| CONTR3-12 | `SnapshotTimingStats.backends` is keyed by producer, not by backend | inconsistent | low | high | S | sonnet |
| CONTR3-13 | Small logic leftovers in the files read | unneeded | low | high | S | sonnet |

### [contracts-clients.md](findings/contracts-clients.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| CONTR-1 | Upload client follows redirects to any origin and re-sends the daemon bearer token | broken | high | high | S | sonnet |
| CONTR-2 | Proxy's default 5-minute upstream timeout is shorter than the client envelopes it carries, and expiry cancels the daemon work | inconsistent | medium | high | S-M | opus |
| CONTR-3 | Proxy answers `/rpc` failures with a REST-shaped body the client cannot read; message and code are lost | inconsistent | medium | high | S | sonnet |
| CONTR-4 | A remote daemon's response chooses the local path the client writes artifacts to | broken | medium | medium | M | opus |
| CONTR-6 | Two same-named, differently-shaped `BackendSnapshotResult` types exported from `@agent-device/contracts` | inconsistent | medium | high | S-M | sonnet |
| CONTR-5 | Remote diagnostics path escapes `remote-diagnostics/` for session `..` (guard documented in the same file is not applied) | broken | low | high | S | sonnet |
| CONTR-7 | Client artifact download treats 3xx as success and can sit 90 s on a truncated error body | broken | low | high | S | sonnet |
| CONTR-8 | Keyboard action vocabulary is spelled in six places with three different member sets; its "owner" lives in session-journal | inconsistent | low | high | S-M | sonnet |
| CONTR-9 | `InteractionTarget` / `PointTarget` / `RefTarget` / `SelectorTarget` / `ElementTarget` each exist twice in contracts with incompatible shapes | inconsistent | low | high | M | sonnet |
| CONTR-10 | Lease error reasons the client dispatches on have no producer or no shared constant | unneeded | low | medium | S | sonnet |
| CONTR-11 | `buildLeaseDiagnosticsContext` and `LeaseDiagnosticsContext` are production exports used only by one daemon test | unneeded | low | high | S | sonnet |
| CONTR-12 | Upload has a fixed 5-minute whole-transfer cap independent of size; fallback restarts from byte 0; retry swallows aborts | broken | low | medium | S-M | sonnet |
| CONTR-13 | Proxy trusts a client-supplied `x-forwarded-proto` verbatim when building the upload ticket URL | broken | low | high | S | sonnet |
| CONTR-14 | Connection-state validator still admits the superseded `daemon.authToken` field | unneeded | low | high | S | sonnet |
| CONTR-15 | Small duplicated owners inside `packages/remote` | inconsistent | low | high | S | sonnet |
| CONTR-16 | Stale, orphaned, and history-narrating comments (AGENTS.md comment rule) | inconsistent | low | high | S | sonnet |
| CONTR-17 | Tests that cannot fail at runtime | broken | low | high | S | sonnet |
| CONTR-18 | `waitForDaemonExit` spawns a synchronous `ps` every 100 ms while a daemon is still alive | inefficient | low | medium | S | sonnet |
| CONTR-19 | Socket transport accepts any JSON line as the response; cleanup failure masks the request error | broken | low | medium | S | sonnet |

### [daemon-core.md](findings/daemon-core.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| DCORE-1 | Ordinary `close --save-script` reports success when the script write fails with a filesystem error | broken | medium | high | S | opus |
| DCORE-2 | Ordinary `bindDevice` has no late-binding cleanup; a bind that completes after request disposal is never disposed | broken | medium | medium | S | opus |
| DCORE-3 | `swipe --count N` recording overlays are anchored at the last repetition when native gesture timing is present | broken | medium | medium | M | opus |
| DCORE-4 | A recorded `fill <target> ""` (clear) with a resolved selector chain is rejected as "never resolved to a selector" | broken | medium | medium | S | sonnet |
| DCORE-5 | `captureSnapshot` still falls back to the legacy interactor capture for callers that pass no `captureData` | inconsistent | medium | medium | M | opus |
| DCORE-6 | `applyRecordedSaveScriptFlags` keeps an unreachable `none -> authoring` arm as a declared safety net | unneeded | low | high | S | sonnet |
| DCORE-7 | `stripInternalInteractionFlags` and the `postGestureStabilization === true` arm have no producer | unneeded | low | high | S | sonnet |
| DCORE-8 | `deviceLease` "session compatibility input" in `lease-context.ts` has no producer | unneeded | low | high | S | sonnet |
| DCORE-9 | `DeferredSurface.stabilize.markedAt` is written and documented as load-bearing but never read | inconsistent | low | high | S | opus |
| DCORE-10 | Two admission modules duplicate the gateway guards and the admission loop | inconsistent | low | high | S | sonnet |
| DCORE-11 | Dead and constant output in the script writer | unneeded | low | high | S | sonnet |
| DCORE-12 | `.trimEnd()` binds to the last template literal only, so the device-in-use hint ends with a space | broken | low | high | S | sonnet |
| DCORE-13 | `resolveRecordingDurationMs` ranks the wall-clock fallback above explicit candidates, so its candidates and default constants are unreachable | inconsistent | low | high | S | opus |
| DCORE-14 | `interactionSurfaceSemanticKey` can never return `undefined` | unneeded | low | high | S | opus |
| DCORE-15 | The device-readiness TTL cache has no invalidation | broken | low | low | S | opus |
| DCORE-16 | Comments that narrate history, name callers, or are orphaned (AGENTS.md comment rule) | inconsistent | low | high | S | sonnet |
| DCORE-17 | `PlatformOwnerLifecycle` still carries recovery phases for state left by older agent-device versions | unneeded | low | low | M | opus |

### [daemon-execution.md](findings/daemon-execution.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| DEXEC-1 | `type` rejects legitimate text that starts with `@el…`, `@node…`, `@ref…` or `@name9` | broken | medium | high | S | sonnet |
| DEXEC-2 | a rejected `type @e5 …` expires the ref frame, so its own hint ("Use fill @e5") cannot work | broken | medium | high | S | sonnet |
| DEXEC-3 | `trigger-app-event` reads the Android URL template for web/Linux/HarmonyOS and hints an env var nobody reads | inconsistent | medium | high | S | sonnet |
| DEXEC-4 | a sessionless duration wait (`wait 500`) resolves a target device before sleeping | inefficient | medium | medium | S | sonnet |
| DEXEC-5 | Android screen recording adds a full accessibility snapshot before every generic command and every `type`, beside a second ANR detector | inefficient | medium | medium | M | opus |
| DEXEC-6 | listing downloadable artifacts builds a `tar czf` archive of every directory artifact | inefficient | medium | high | M | opus |
| DEXEC-7 | `alert` subaction handling disagrees between the daemon handler and the registry | inconsistent | medium | high | S | sonnet |
| DEXEC-8 | any failed `is`/`wait` on Android can be rewritten as a "foreground surface" failure, including argument errors | broken | low | high | S | sonnet |
| DEXEC-9 | a failed `screenshot <path> --crop-on` leaves the uncropped full-frame image at the caller's path | broken | low | high | S | sonnet |
| DEXEC-10 | `react-native dismiss-overlay` loses the dispatched tap when the verification capture throws, and reports `dismissed: true` while the overlay is still detected | broken | low | medium | S | sonnet |
| DEXEC-11 | several commands validate arguments only after binding the device or after Android dialog work | inconsistent | low | high | M | sonnet |
| DEXEC-12 | Android snapshot-timeout evidence leaves a temp directory per timeout | broken | low | high | S | sonnet |
| DEXEC-13 | Android dialog recovery polls ignore request cancellation | broken | low | high | S | sonnet |
| DEXEC-14 | `putHostLease` breaks the "issued lease id is never reused" invariant and marks a tenant before validation | inconsistent | low | medium | S | opus |
| DEXEC-15 | the Android "tap escaped the app" failure is recognised by the shape of its details, not a typed reason | inconsistent | low | high | S | sonnet |
| DEXEC-16 | duplicate and pass-through helpers | unneeded | low | high | S | sonnet |
| DEXEC-17 | migration-history comments throughout the slice | unneeded | low | high | S | sonnet |
| DEXEC-18 | best-effort paths swallow errors with bare `catch` and emit no diagnostic | broken | low | medium | S | sonnet |
| DEXEC-19 | directional scroll analyses the same trees for the scroll edge up to four times per command | inefficient | low | medium | M | opus |
| DEXEC-20 | `session-snapshot.ts` claims a single write choke point but has three writers with different invariants | inconsistent | low | low | S | opus |

### [daemon-server-core.md](findings/daemon-server-core.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| DSRV-1 | Daemon-level diagnostics emitted outside any diagnostics scope are silently dropped | broken | medium | high | M | opus |
| DSRV-2 | Session-teardown timeout timer is never cancelled: false "timed out" line and event loop held after close | broken | medium | high | S | sonnet |
| DSRV-3 | Socket transport buffers unbounded input before authentication | broken | medium | high | S | sonnet |
| DSRV-4 | `parseIntegerEnv('')` returns 0, so an empty lease env var yields a 1 ms lease TTL | broken | medium | high | S | sonnet |
| DSRV-5 | Upload routes inherit Node's default 300 s `requestTimeout` while accepting 2 GiB bodies | broken | medium | medium | S | opus |
| DSRV-6 | Legacy `/upload` ignores the client's `x-artifact-hash`; only the resumable path verifies integrity | inconsistent | medium | high | S | sonnet |
| DSRV-7 | Request-diagnostics route leaks a file descriptor when the client disconnects mid-stream | broken | low | medium | S | sonnet |
| DSRV-8 | `/rpc` has its own body reader that counts UTF-16 units and answers oversize with a connection reset | inconsistent | low | high | S | sonnet |
| DSRV-9 | Unauthenticated socket requests count as daemon activity and re-arm the idle reap | broken | low | medium | S | opus |
| DSRV-10 | Streaming `/rpc` contract comment contradicts the code: headers are not sent before the handler starts | inconsistent | low | high | S | opus |
| DSRV-11 | Token extraction is implemented twice and the gate order differs between `/rpc` and the auxiliary routes | inconsistent | low | high | M | opus |
| DSRV-12 | Five different request-target parsers; query strings and encoding are handled differently per route | inconsistent | low | high | S | sonnet |
| DSRV-13 | `platform` and root-name inference in `artifact-archive.ts` are unreachable from production | unneeded | low | high | S | sonnet |
| DSRV-14 | Hyphenated JSON-RPC method aliases have no producer in the repo | unneeded | low | medium | S | sonnet |
| DSRV-15 | Preflight for an existing resumable upload returns the ticket without refreshing its expiry | broken | low | medium | S | sonnet |
| DSRV-16 | Remote host-input restriction runs twice per HTTP request | inefficient | low | high | S | opus |
| DSRV-17 | Comments that record history or name callers, against the AGENTS.md comment rule, some stale | inconsistent | low | high | S | sonnet |

### [daemon-sessions.md](findings/daemon-sessions.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| DSESS-1 | Inline `push` JSON longer than 255 bytes fails with "Unable to read Push payload file" | broken | medium | high | S | sonnet |
| DSESS-2 | Suite-owned test-session close never calls the lease provider | broken | medium | medium | S | opus |
| DSESS-3 | Ordinary `close` reports success when the script write fails with a filesystem error | broken | medium | medium | S | opus |
| DSESS-4 | Relative paths resolve against two different working directories | inconsistent | medium | medium | S | sonnet |
| DSESS-6 | `doctor` without `--platform` reads each platform inventory one after another | inefficient | medium | high | S | sonnet |
| DSESS-7 | Required dependencies are typed optional, hiding 30 runtime guards and silent no-ops | inconsistent | medium | high | M | opus |
| DSESS-5 | `--retention-ms` above 2^31-1 deletes retained paths at once while reporting a far-future expiry | broken | low | high | S | sonnet |
| DSESS-8 | Three ways to turn an error into a response; the hand-built one skips redaction and hint lifting | inconsistent | low | medium | S | sonnet |
| DSESS-9 | `perf` stop loses the tenant that `perf` start and `record` attribute output to | inconsistent | low | medium | S | sonnet |
| DSESS-10 | `handleSessionCommands` destructures 26 fields and rebuilds the same object (baselined complexity debt) | unneeded | low | high | S | sonnet |
| DSESS-11 | Three complexity gates are suppressed inline | inconsistent | low | high | M | opus |
| DSESS-12 | Dead flag, dead parameter, dead re-export, fake lazy loader, unreachable branches | unneeded | low | high | S | sonnet |
| DSESS-13 | Snapshot handler table is not exhaustive, and the session table's comment says it is | inconsistent | low | high | S | sonnet |
| DSESS-14 | Android allowlist sort idiom copied five times | inconsistent | low | high | S | sonnet |
| DSESS-15 | `doctor` colour follows the daemon's stderr, not the caller's terminal | inconsistent | low | medium | M | sonnet |
| DSESS-16 | `doctor` remote-scope evidence uses a hand-copied flag list | inconsistent | low | high | S | sonnet |
| DSESS-17 | `logs` binds the device runtime twice per command, and three actions bind only to discard | inefficient | low | medium | S | opus |
| DSESS-18 | Session scope does a synchronous filesystem walk on every call, with no memo | inefficient | low | medium | S | sonnet |
| DSESS-19 | `runtime set --platform apple` is refused on an iOS session | broken | low | medium | S | sonnet |
| DSESS-20 | `network` limit accepts trailing junk | broken | low | high | S | sonnet |
| DSESS-21 | Comments that narrate history or are stale | unneeded | low | high | S | sonnet |

### [maestro-replay-rn-2.md](findings/maestro-replay-rn-2.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| REPLAY2-1 | `test` classifies a failure as infrastructure by substring-matching the error message, which stops retries for ordinary failures | broken | medium | high | M | opus |
| REPLAY2-2 | Divergence `suggestions[].ref` and `targetBinding.candidates[].ref` are returned without being in the published ref scope | broken | medium | medium | S | opus |
| REPLAY2-3 | `replay export` turns `wait stable`, `wait @ref`, and a bare `wait text` into waits for literal on-screen text | broken | medium | high | S | sonnet |
| REPLAY2-4 | `ensureCompanionTunnel` is an unlocked read-check-spawn-write, so two concurrent callers start two companions and one is orphaned | broken | medium | medium | M | opus |
| REPLAY2-5 | A CDP call sent after the debugger socket closed waits the full 30 s timeout | broken | low | medium | S | sonnet |
| REPLAY2-6 | Exported tap/swipe points use a looser numeric test than the Maestro parser accepts | inconsistent | low | high | S | sonnet |
| REPLAY2-7 | Percent coordinates are rendered as `50,50%` in progress, trace, and failure labels, and a test pins the wrong text | broken | low | high | S | sonnet |
| REPLAY2-8 | `invokeOperation` discards every observation its callers build; `observationForTarget` and `defaultArtifacts` are dead | unneeded | low | high | S | sonnet |
| REPLAY2-9 | The conformance record says `waitForAnimationToEnd` diffs a hierarchy signature; the code diffs screenshots | inconsistent | low | high | S | sonnet |
| REPLAY2-10 | `maestro/src/index.test.ts` asserts the absence of two symbols that exist nowhere in the repository | broken | low | high | S | sonnet |
| REPLAY2-11 | The "strict wait absent" export test accepts any export failure | broken | low | high | S | sonnet |
| REPLAY2-12 | `MaestroFailureReportProjection` carries three fields only a test reads | unneeded | low | high | S | sonnet |
| REPLAY2-13 | Backend action failures compute `repairHint` through a call that can only return `'manual'` | unneeded | low | high | S | sonnet |
| REPLAY2-14 | `replay-port` adds four more numeric-token rules, and its wait-timeout rule disagrees with the wait parser | inconsistent | low | high | S | sonnet |
| REPLAY2-15 | Companion state stores a `command` field nothing reads; the contract file comment claims a re-export that is not there | unneeded | low | high | S | sonnet |
| REPLAY2-16 | Exported `inputText` does not escape `${...}`, which Maestro evaluates as JavaScript | broken | low | medium | S | opus |
| REPLAY2-17 | Inspect commands report "The profiler runtime threw inside the app" | inconsistent | low | high | S | sonnet |
| REPLAY2-18 | `withReplayFailureDiagnostics` is a one-line wrapper around a private function with the same parameters | unneeded | low | high | S | sonnet |
| REPLAY2-19 | `isStaticAppTarget` is implemented twice with identical bodies | inconsistent | low | high | S | sonnet |
| REPLAY2-20 | The `evalScript` guard error prints the path and "line" with no separator | broken | low | high | S | sonnet |
| REPLAY2-21 | `scrollUntilVisible` can never succeed when the snapshot yields no reference frame | broken | low | low | S | opus |

### [maestro-replay-rn.md](findings/maestro-replay-rn.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| REPLAY-1 | Recorded literal `${...}` text is re-interpolated on replay (writer never emits the `\${` escape the resolver supports) | broken | medium | high | S | opus |
| REPLAY-2 | `runScript` blocks the daemon event loop for up to 30 s per call (sync `vm` + `spawnSync` HTTP) | broken | medium | high | M | opus |
| REPLAY-3 | `runScript` HTTP responses over ~1 MiB fail with a spawn buffer error, contradicting the declared 8 MiB cap | broken | medium | high | S | sonnet |
| REPLAY-4 | `eraseText.charactersToErase` has no upper bound; a large value allocates a giant string or throws a raw `RangeError` in the daemon | broken | medium | high | S | sonnet |
| REPLAY-5 | `actionSourcePaths` is threaded through three packages but no producer ever sets it | unneeded | medium | high | S | sonnet |
| REPLAY-6 | Maestro `launchApp.arguments` map is passed as bare `key value` pairs, not the `-key value` launch arguments upstream Maestro produces | inconsistent | medium | medium | S | opus |
| REPLAY-7 | Maestro flows accept mixed-case variable names, but `-e` and `AD_VAR_*` reject anything that is not UPPER_SNAKE | inconsistent | medium | high | S | sonnet |
| REPLAY-8 | `repeat` with `while` and no `times` has no iteration or time ceiling | broken | medium | medium | S | opus |
| REPLAY-9 | Suite-level failures drop the typed error `details`/`hint` | broken | low | high | S | sonnet |
| REPLAY-10 | `healed` result field is always `0` | unneeded | low | high | S | sonnet |
| REPLAY-11 | `.ad` header metadata is strict about duplicates but silently drops invalid values, and matches keys inside the quoted device name | inconsistent | low | high | S | sonnet |
| REPLAY-12 | Three different "is this a coordinate" predicates for `fill`/`click` targets | inconsistent | low | high | S | sonnet |
| REPLAY-13 | Source-location suffixing decides by matching error message text | inconsistent | low | high | S | sonnet |
| REPLAY-14 | Resume validation is implemented twice with diverging user-facing text | inconsistent | low | high | S | sonnet |
| REPLAY-15 | `runScript` exposes only `http.post`; the `GET` method and trust default are dead or fail-open surface | inconsistent | low | high | S | sonnet |
| REPLAY-16 | Legacy snapshot tokens and parse/write asymmetry in the `.ad` grammar | unneeded | low | high | S | sonnet |
| REPLAY-17 | `tmp-dir.fixtures.ts` copies kept under `fallow-ignore` although `@agent-device/test-kit` exports the same helpers | unneeded | low | high | S | sonnet |
| REPLAY-18 | Duplicate explicit shard devices run two shards on one device | broken | low | medium | S | sonnet |
| REPLAY-19 | A `test` attempt has no timeout unless the caller or the script sets one | broken | low | low | S | opus |
| REPLAY-20 | Retry cap is defined twice and script metadata over the cap is clamped silently | inconsistent | low | high | S | sonnet |
| REPLAY-21 | `waitForAnimationToEnd` retries a failing screenshot capture back-to-back with no delay until the deadline | inefficient | low | medium | S | sonnet |
| REPLAY-22 | Flow config `tags` is parsed and validated but nothing reads it | unneeded | low | high | S | sonnet |
| REPLAY-23 | Comment volume and change-history narration in `ad-replay`, `replay-port`, `ad-script` | unneeded | low | high | M | sonnet |
| REPLAY-24 | `scrollRegion.id` validation errors name the wrong field | inconsistent | low | high | S | sonnet |
| REPLAY-25 | `replay-port` publishes 30 subpath exports; 12 have no importer outside the package | unneeded | low | medium | S | sonnet |
| REPLAY-26 | Directory suite order is raw filesystem order, including for native `.ad` suites | inconsistent | low | medium | S | sonnet |

### [platform-android-2.md](findings/platform-android-2.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| ANDR2-1 | `record stop` fails permanently when any chunk's recorder pid was reassigned, although every other recording path treats that as proof of termination | broken | medium | high | M | opus |
| ANDR2-2 | Restore and doctor read a failed `default_input_method` probe as "helper not active" and retire the recovery evidence | broken | medium | high | S | opus |
| ANDR2-3 | `deployApp` discards the device that readiness returns; the comment that justifies the call contradicts the daemon | inconsistent | medium | high | S | opus |
| ANDR2-12 | Device inventory spends 6 adb round trips per device on TV detection, and emulator readiness re-runs the full inventory every second | inefficient | medium | high | S | sonnet |
| ANDR2-4 | `record stop` rejects after the export was served when the device reports a failed chunk removal | inconsistent | low | high | S | sonnet |
| ANDR2-5 | First-chunk launch has a `/data/local/tmp` fallback that an unwritable `/sdcard` never reaches | broken | low | medium | S | opus |
| ANDR2-6 | Clipboard-support verdict is cached per serial for the owner's lifetime, and the probe runs without signal or timeout on every fact inspection of an unreachable device | broken | low | high | S | sonnet |
| ANDR2-7 | Rotation timer is anchored after the previous recorder is stopped, so a chunk can pass Android's 180 s limit without disclosure | broken | low | medium | S | opus |
| ANDR2-8 | `notifications.ts` is a dead second implementation of the push broadcast | unneeded | low | high | S | sonnet |
| ANDR2-9 | `app-deployment.ts` is a dead second install pipeline, with a second diverging `inferAndroidAppName` | unneeded | low | high | S | sonnet |
| ANDR2-10 | The `mechanics.ts` barrel exports 127 names that nothing outside the package references | unneeded | low | high | M | sonnet |
| ANDR2-11 | The `.aab` manifest candidate cannot parse a real bundle, and the `aapt` fallback cannot either | unneeded | low | high | S | sonnet |
| ANDR2-13 | Two boot waiters disagree on timeout, reason, cancellation, and transport | inconsistent | low | high | M | opus |
| ANDR2-14 | Sibling settings follow three different contracts for verification and cancellation | inconsistent | low | high | M | opus |
| ANDR2-15 | SDK tool resolution has two root lists, and `doctor` probes a different adb than the one in the supplied environment | inconsistent | low | medium | S | sonnet |
| ANDR2-16 | Recording test fixture still translates a retired transport shape | unneeded | low | high | M | sonnet |
| ANDR2-17 | Pure-parser property tests spawn `unzip` for every generated case; recording finalization tests wait in real time | inefficient | low | high | S | sonnet |
| ANDR2-18 | `buildUiHierarchySnapshot` can report `truncated` when every presentable node fit | broken | low | medium | S | sonnet |
| ANDR2-19 | Network dump resolves the app pid twice and without a timeout | inefficient | low | high | S | sonnet |

### [platform-android.md](findings/platform-android.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| ANDR-1 | `input text` fallback silently turns a literal `%s` in user text into a space | broken | medium | high | S | sonnet |
| ANDR-2 | Test-IME text entry reports success when the IME committed nothing (or truncated) | broken | medium | high | M | opus |
| ANDR-3 | Persistent helper session listens on an unauthenticated device-loopback TCP port, with no read timeout | broken | medium | medium | M | opus |
| ANDR-4 | Two disagreeing "foreground app" readers; the runtime `appState` operation uses the one that always pays a dump that cannot answer on Android 16 | inconsistent | medium | high | M | opus |
| ANDR-5 | `open <package>` fails with a warm helper session where the adb path would fall back | inconsistent | medium | medium | S | sonnet |
| ANDR-6 | A helper-reported, non-dispatched failure tears down the warm session | inefficient | medium | medium | S | opus |
| ANDR-7 | Every snapshot tokenizes and attribute-parses the helper XML twice, and builds the hierarchy twice for interactive snapshots | inefficient | medium | high | M | opus |
| ANDR-8 | Helper artifact is re-resolved from disk on every command, by two different resolvers | inefficient | medium | high | S | sonnet |
| ANDR-9 | Two helper-install pipelines with different caching, recovery, and version parsing | inconsistent | low | high | M | opus |
| ANDR-10 | `readScreenSize` ignores `wm size` overrides and rotation; a second copy exists only for tests | broken | low | medium | S | opus |
| ANDR-11 | Session acquisition has no single-flight per device, and a forward can leak before the `try` | broken | low | low | M | opus |
| ANDR-12 | Port-reverse manager is rebuilt per call, so its ownership tracking and dedupe never apply to localhost opens | broken | low | high | S | sonnet |
| ANDR-13 | Boot failure classification matches the module's own error message text | inconsistent | low | high | S | sonnet |
| ANDR-14 | Dead native protocol surface the host never uses | unneeded | low | high | S | sonnet |
| ANDR-15 | Helper timeout/limit constants drift between constants, defaults, native code, and diagnostics | inconsistent | low | high | S | sonnet |
| ANDR-16 | Host port round-trips into the package's own module for helper artifact/installation | unneeded | low | high | S | sonnet |
| ANDR-17 | Stabilized screenshot leaves `sysui_demo_allowed=1` on the device | broken | low | high | S | sonnet |
| ANDR-18 | `isAndroidPackageInstalled` has a dead branch | unneeded | low | high | S | sonnet |
| ANDR-19 | Key/back/home/app-switcher dispatch does not disclose dispatch state the way tap does; TV-remote duration is discarded | inconsistent | low | medium | S | sonnet |

### [platform-apple-2.md](findings/platform-apple-2.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| APPLE2-1 | An idle guest-bridge socket has no `error` listener, and the daemon exits on any uncaught exception | broken | medium | medium | S | opus |
| APPLE2-2 | `network dump` fails outright when the optional simulator recovery pass takes longer than 4 s | broken | medium | medium | S | sonnet |
| APPLE2-3 | The recovery `log show` predicate is a stale copy of the live-stream predicate and drops the executable-name clauses | inconsistent | medium | medium | S | sonnet |
| APPLE2-4 | Each simulator bridge snapshot spawns `ps -p <pid> -o lstart=` three times | inefficient | medium | high | S | opus |
| APPLE2-5 | The "simulator runtime did not provide `ps`" memgraph branch is unreachable, and its test fakes an exec behavior production cannot produce | broken | medium | high | S | sonnet |
| APPLE2-6 | Launch-confirmation handling is skipped on iPad simulators | broken | medium | low | S | opus |
| APPLE2-7 | Perf on macOS resolves the bundle with Spotlight and then demands an exact executable-path match | broken | medium | medium | M | opus |
| APPLE2-8 | Recording invalidation logic is dead on the simulator path and inverted against its own comment; the daemon keys it on a string literal | inconsistent | low | high | S | sonnet |
| APPLE2-9 | Runner-backed recording cleanup throws where every other cleanup returns `cleanup-pending` | inconsistent | low | medium | S | sonnet |
| APPLE2-10 | Race timers are never cleared: 45 s after every xctrace stop, and up to the full capture budget after every bridge request | inefficient | low | high | S | sonnet |
| APPLE2-11 | The wire-vocabulary parity test pins constants that production code does not use | inconsistent | low | high | S | sonnet |
| APPLE2-12 | `tree.ts` decoder has an unreachable limit check, a triple `truncated` validation and per-node repeated work | unneeded | low | high | S | sonnet |
| APPLE2-13 | `perf memory snapshot` reports two different method names for the same capture, one of them not a real tool | inconsistent | low | high | S | sonnet |
| APPLE2-14 | The xctrace background capture bypasses the Apple tool provider that the rest of perf uses | inconsistent | low | medium | M | opus |
| APPLE2-15 | The injected-runner interactor guards `readClipboard` but not `writeClipboard` | inconsistent | low | medium | S | sonnet |
| APPLE2-16 | A frame-health sample runs three `xctrace export` processes one after another | inefficient | low | medium | S | sonnet |
| APPLE2-17 | Stale and orphaned doc comments left by rewrites | unneeded | low | high | S | sonnet |
| APPLE2-18 | Bridge timing and log bounds are repeated as bare literals with different units | inconsistent | low | high | S | sonnet |
| APPLE2-19 | `interactions.ts` carries duplicate command builders and an injection parameter with one constant caller | unneeded | low | high | S | sonnet |
| APPLE2-20 | A few tests assert on wall-clock time | broken | low | medium | S | sonnet |
| APPLE2-21 | `debug symbols` does avoidable sequential spawns and stats | inefficient | low | high | S | sonnet |

### [platform-apple.md](findings/platform-apple.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| APPLE-1 | macOS helper recomputes its source fingerprint (17 file reads + a `swift --version` spawn) on every helper call, with no single-flight on the build | inefficient | high | high | M | opus |
| APPLE-2 | Listing macOS apps spawns one `plutil` per `.app`, all at once, plus three unbounded `find` runs | inefficient | high | high | M | sonnet |
| APPLE-3 | The "recently observed Booted" memo is re-armed by its own cache hits, so it never expires under steady use | broken | medium | high | S | sonnet |
| APPLE-4 | `reinstall` uninstalls the installed app before the replacement artifact is validated | broken | medium | high | S | opus |
| APPLE-5 | Two independent simulator-boot implementations with different budgets, retries and errors | inconsistent | medium | high | L | opus |
| APPLE-6 | Many simctl and host spawns have no timeout; exec has no default | broken | medium | high | M | sonnet |
| APPLE-7 | Reading three keys from one `Info.plist` costs 3–6 `plutil` spawns, through a three-layer fallback chain | inefficient | medium | high | S | sonnet |
| APPLE-8 | Four implementations of "simulator app container → Info.plist", three of which bypass the `(null)` reader | inconsistent | medium | high | M | sonnet |
| APPLE-9 | Closing an app on a physical device costs three sequential `devicectl` spawns and cannot be cancelled | inefficient | medium | high | M | opus |
| APPLE-10 | Screenshot retry and fallback decisions match error text, including host-kit's own timeout message | inconsistent | medium | high | S | sonnet |
| APPLE-11 | Every non-simulator device discovery runs `xcrun xctrace list devices`, unbounded | inefficient | medium | medium | S | sonnet |
| APPLE-12 | Native-helper preparation is repeated per request: three toolchain spawns plus a binary SHA-256 before each scoped-simulator display read | inefficient | medium | medium | S | sonnet |
| APPLE-13 | URL-scheme owner lookup spawns `plutil` once per installed app, sequentially | inefficient | low | high | S | sonnet |
| APPLE-14 | Simulator launch retry declares 10 attempts but can never make more than 3 | inconsistent | low | high | S | sonnet |
| APPLE-15 | `ensureBootedSimulator` can run 2× past its deadline per attempt and re-lists after a successful `bootstatus` | broken | low | high | S | sonnet |
| APPLE-16 | The xctrace device parser drops physical devices whose user-assigned name lacks "iPhone/iPad/Apple TV" | broken | low | medium | M | opus |
| APPLE-17 | Per-simulator caches disagree on what identifies a simulator | inconsistent | low | medium | S | sonnet |
| APPLE-18 | Small duplicated helpers and redundant calls | unneeded | low | high | S | sonnet |

### [providers-platforms-2.md](findings/providers-platforms-2.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| PROV2-1 | WebDriver `home` and `appSwitcher` send `mobile: pressButton` to Android, which UiAutomator2 does not have | broken | medium | high | S | opus |
| PROV2-2 | HarmonyOS recorder stop is the same toggle as start, and cleanup sends it without knowing the recorder is running | broken | medium | medium | M | opus |
| PROV2-3 | WebDriver `openDevice` sends `mobile: activateApp` with an empty argument object | broken | medium | medium | S | opus |
| PROV2-4 | Every WebDriver scroll reads and parses the whole page source first, with no timeout and no cancellation | inefficient | medium | high | M | opus |
| PROV2-5 | Recording the managed browser fleet runs two synchronous `ps` spawns per process | inefficient | medium | high | S | sonnet |
| PROV2-6 | HarmonyOS admits `perf frames` and `perf memory snapshot`, and both operations only ever answer "unavailable" | inconsistent | low | high | S | sonnet |
| PROV2-7 | Refusal messages borrowed from unrelated cells in four runtimes | inconsistent | low | high | S | sonnet |
| PROV2-8 | Web snapshot value parsing reads inside quoted names | broken | low | high | S | sonnet |
| PROV2-9 | Managed-fleet daemon matching claims any non-Chrome process whose command line mentions the install directory | broken | low | medium | S | opus |
| PROV2-10 | WebDriver iOS `keyboard enter` branch is unreachable while the capability note advertises it | inconsistent | low | high | S | sonnet |
| PROV2-11 | HarmonyOS deployment carries a second copy of the launch-target logic | inconsistent | low | high | S | sonnet |
| PROV2-12 | HarmonyOS recording finish copies the media at least twice and throws untyped errors | inefficient | low | high | M | opus |
| PROV2-13 | Dead parameters and fields | unneeded | low | high | S | sonnet |
| PROV2-14 | Limrun's platform runtime owner is still named and worded as an app-log owner | inconsistent | low | high | S | sonnet |
| PROV2-15 | Migration-history comments in the runtime fact tables | unneeded | low | high | S | sonnet |
| PROV2-16 | Tests that cannot fail for the reason they name | broken | low | high | S | sonnet |

### [providers-platforms.md](findings/providers-platforms.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| PROV-1 | WebDriver transport loses status, retry and dispatch disclosure when an error body is not JSON | broken | medium | high | S | sonnet |
| PROV-2 | Three lease state machines for the same job, and the same refusal has three different codes and reasons | inconsistent | medium | high | L | opus |
| PROV-3 | Web `fill` and `type` put the typed text in a child process argv and in error details | broken | medium | high | M | opus |
| PROV-4 | Plugin store never deletes superseded or removed installations | broken | medium | high | S | sonnet |
| PROV-5 | Linux Wayland long-press and drag call `ydotool click --down/--up`, which ydotool v1 does not have | broken | medium | medium | S | opus |
| PROV-6 | Linux `open <binary>` runs the app as a captured `runCmd` child for its whole lifetime | broken | medium | high | S | sonnet |
| PROV-7 | Hosted app upload has no deadline, untyped transport failures, and reads the whole app into memory | inconsistent | medium | high | S | sonnet |
| PROV-8 | AWS Device Farm artifact lookup picks its region differently from the session that created the artifacts | broken | medium | medium | S | sonnet |
| PROV-9 | A malformed CDP frame or event throws inside the WebSocket handler | broken | medium | medium | S | sonnet |
| PROV-10 | A single transient failure on session delete leaves a billed WebDriver session | broken | medium | medium | M | opus |
| PROV-11 | AT-SPI dump drops everything below depth 12 without reporting truncation | broken | medium | medium | S | sonnet |
| PROV-12 | xdotool long-press and drag leave the mouse button held when a step fails | broken | low | high | S | sonnet |
| PROV-13 | AWS readiness loop discards a session that became RUNNING on the last poll | broken | low | high | S | sonnet |
| PROV-14 | AWS WebDriver endpoint selection guesses from unrelated fields and downgrades to `http://` | inconsistent | low | medium | S | opus |
| PROV-15 | Every web command resolves the managed-backend status three times with synchronous file I/O | inefficient | low | high | S | sonnet |
| PROV-16 | `binaryPath` in the managed web status points at the shim the code forbids running | unneeded | low | high | S | sonnet |
| PROV-17 | Linux screenshot tools run with no timeout and ignore the declared screenshot options | inconsistent | low | high | S | sonnet |
| PROV-18 | HarmonyOS long-press accepts a duration and ignores it | inconsistent | low | high | S | sonnet |
| PROV-19 | HarmonyOS `keyboard dismiss` sends Back without knowing a keyboard is up | broken | low | medium | M | opus |
| PROV-20 | v1 plugin compatibility path is scheduled for removal at 0.22 and still spans four files | unneeded | low | high | M | sonnet |
| PROV-21 | BrowserStack and TestMu boilerplate has drifted | inconsistent | low | high | S | sonnet |
| PROV-22 | tv-cdp polls the inspector once a second per attached TV and adds unabortable sleeps to every tap | inefficient | low | high | S | sonnet |
| PROV-23 | WebDriver session manager bookkeeping grows for the daemon's lifetime | inefficient | low | high | S | sonnet |
| PROV-24 | `wl-copy` is run with piped stdio and a 5 s timeout | broken | low | low | S | opus |
| PROV-25 | A Linux tap costs three process spawns | inefficient | low | high | S | sonnet |
| PROV-26 | webOS device listing throws a raw `SyntaxError` | broken | low | high | S | sonnet |
| PROV-27 | AT-SPI bridge classifies failures by matching stderr text and shows the helper's JSON error raw | inconsistent | low | high | S | sonnet |

### [src-cli-mcp-sdk-2.md](findings/src-cli-mcp-sdk-2.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| SRC2-1 | Android recording writer scan spawns three `adb shell` calls for every process on the device | inefficient | medium | high | S | opus |
| SRC2-2 | Managed-process identity reads block the daemon event loop with synchronous `ps` | inefficient | medium | high | M | opus |
| SRC2-3 | `app.log` rotates only when the sink opens; docs say it rotates at 5 MB; `network dump` reads the whole file synchronously | inconsistent | medium | high | M | opus |
| SRC2-4 | App-log redaction patterns break on a comma and fail silently on an invalid regex | broken | medium | high | S | sonnet |
| SRC2-5 | `disconnect` hides a failed lease release and deletes the only local record of the lease | broken | medium | high | S | sonnet |
| SRC2-6 | `connect limrun` mints a time-based run id, so a second connect of the same session is always "a different connection"; generated profiles are never removed | inconsistent | medium | medium | S | opus |
| SRC2-7 | `finalize.complete` declares and forwards an abort signal that the finalizer drops | broken | low | high | S | sonnet |
| SRC2-8 | Public `agent-device/android-adb` loads all six platform packages for one function; `limrun-runtime-dependencies.ts` "lazy" imports are not lazy | inefficient | low | high | S | sonnet |
| SRC2-9 | Each Limrun XCTest launch re-reads and re-hashes the whole `Runner.app` | inefficient | low | high | S | sonnet |
| SRC2-10 | Replay-test reporters: one failing `onSuiteEnd` skips the reporters after it; `test --json` prints `success: true` with a non-zero exit | inconsistent | low | high | S | sonnet |
| SRC2-11 | Provider capability lookups read `process.env` in 12 call sites while 5 pass the captured host | inconsistent | low | high | S | sonnet |
| SRC2-12 | Host-process termination paths with no escalation or no cancel | broken | low | medium | S | opus |
| SRC2-13 | Latent busy loop in `cachedProducts` after an abort that loses the race with a successful upload | broken | low | low | S | sonnet |
| SRC2-14 | Small dead or duplicated wiring | unneeded | low | high | S | sonnet |

### [src-cli-mcp-sdk.md](findings/src-cli-mcp-sdk.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| SRC-1 | MCP stdin decoder stalls or drops requests after a blank or malformed line | broken | high | high | S | sonnet |
| SRC-2 | MCP server handles every request strictly serially, so `ping` and cancellation wait behind a running tool call | broken | medium | high | M | opus |
| SRC-3 | Session lock policy exists only in the CLI; MCP and the AI SDK ignore `AGENT_DEVICE_SESSION_LOCK` / `sessionLock` | inconsistent | medium | high | M | opus |
| SRC-4 | `AGENT_DEVICE_PLATFORM` is validated against a stale 3-value list, breaking every command that has no `--platform` flag | broken | medium | high | S | sonnet |
| SRC-5 | A failing `test` run exits through bare `process.exit`, the truncation bug #1596 fixed everywhere else | broken | medium | medium | S | sonnet |
| SRC-6 | Every CLI command against a cloud daemon makes an extra token-refresh HTTP round trip | inefficient | medium | high | M | opus |
| SRC-7 | `agent-device mcp <anything>` silently ignores its arguments; flags before `mcp` are rejected | inconsistent | medium | high | S | sonnet |
| SRC-8 | `plugins` resolves the state dir without the host, so a relative `--state-dir` fails only for this command | broken | low | high | S | sonnet |
| SRC-9 | Two tsdown public-SDK chunk groups match no file since the package split | unneeded | low | high | S | sonnet |
| SRC-10 | Cloud endpoints map every non-2xx status to `UNAUTHORIZED` | broken | low | high | S | sonnet |
| SRC-11 | `replay export` on a missing file reports `UNKNOWN: Unexpected internal error` | broken | low | high | S | sonnet |
| SRC-12 | `isDaemonStartupFailure` keeps an error-text fallback next to the typed reason | inconsistent | low | high | S | sonnet |
| SRC-13 | Retired-command handling is split; `runtime` is a hard-coded stub in the dispatcher | inconsistent | low | high | S | sonnet |
| SRC-14 | Argument parser leftovers: silent `-c`, int flags that accept non-integers, a dead branch | broken | low | high | S | sonnet |
| SRC-15 | `auth status` reports an expired session as authenticated | inconsistent | low | high | S | sonnet |
| SRC-16 | AI SDK `platform` pin on the returned client does nothing | broken | low | medium | S | sonnet |
| SRC-17 | `web doctor --json` prints `success: true` and exits non-zero | inconsistent | low | high | S | sonnet |
| SRC-18 | `--debug` tails the daemon log into stdout | inconsistent | low | medium | S | sonnet |
| SRC-19 | Two "legacy" recoveries run on every daemon start with no removal condition | unneeded | low | low | M | opus |
| SRC-20 | Android runtime hints always read and write a speculative `ReactNativeDevPrefs.xml` | inefficient | low | medium | S | opus |
| SRC-21 | Public exports missing from the API reference | inconsistent | low | high | S | sonnet |
| SRC-22 | Root `src/__tests__` holds about 21 test files (about 4.4k lines) that import nothing from root `src/` | unneeded | low | medium | M | sonnet |
| SRC-23 | Test-only mutable global in `provider-device-runtime.ts`; tests exercise the fallback, not the production scope | unneeded | low | medium | S | sonnet |
| SRC-24 | Small wiring and compat leftovers | unneeded | low | high | S | sonnet |

### [tests-docs-website-2.md](findings/tests-docs-website-2.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| TEST2-1 | `exec-wrap-guard` scans only root `src/`, so it misses 87% of `AppError` sites, including two real violations | broken | high | high | S | sonnet |
| TEST2-2 | `package-exports` guard checks a stale hand-kept list and does not enforce "only" | broken | medium | high | S | sonnet |
| TEST2-3 | Android command-contract evidence is checked in one direction, and the largest entry skips the file check | broken | medium | high | S | sonnet |
| TEST2-4 | Apple `simctl` fakes answer success to any unmodeled command, against the suite's own strictness rule | inconsistent | medium | high | M | opus |
| TEST2-5 | Interaction-contract coverage gate accepts a claim that no test carries | broken | medium | medium | M | sonnet |
| TEST2-6 | Four of the thirteen wire-closure waivers are never reached, and nothing reports a stale waiver | unneeded | low | high | S | sonnet |
| TEST2-7 | Provider-scenario scaffolding is copied between test files | inconsistent | low | high | M | sonnet |
| TEST2-8 | `android-world.ts` models adb commands that production does not send | unneeded | low | high | S | sonnet |
| TEST2-9 | `provider-scenarios` harness leaks process state when world creation fails | broken | low | medium | S | sonnet |
| TEST2-10 | Dead rules in `website/src/styles/landing.css` | unneeded | low | high | S | sonnet |
| TEST2-11 | Thirteen of the twenty pixel icons are unused | unneeded | low | high | S | sonnet |
| TEST2-12 | Tombstone and source-regex assertions in `npm-package-scripts.test.ts` | broken | low | medium | S | sonnet |
| TEST2-13 | iOS `checkout-form.ad` and the Maestro fixture suite run in no lane; the website "excerpt" does not match the file | inconsistent | low | medium | S | opus |
| TEST2-14 | `test/wire-compat/ledger.ts` cites a script that does not exist | inconsistent | low | high | S | sonnet |
| TEST2-15 | Unused fixture export `SCREENSHOT_RESULT` | unneeded | low | high | S | sonnet |

### [tests-docs-website.md](findings/tests-docs-website.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| DOCS-1 | Recording E2E tests (and their support code) are run by no lane | unneeded | high | high | M | opus |
| DOCS-2 | Spent output-economy waivers stay live; two of them pre-authorize a 5x size regression | broken | medium | high | S | sonnet |
| DOCS-3 | ADR 0018 says "Nothing in this proposal is implemented" but the journal ships as a package | inconsistent | medium | high | S | opus |
| DOCS-4 | ADR 0024 is "Proposed" while 39 files implement and cite its rules; FORMAT.md forbids proposed ADRs | inconsistent | medium | high | S | opus |
| DOCS-5 | `browserstack.md` TypeScript snippet does not typecheck; the snippet guard compiles only 2 of 12 pages | broken | medium | high | M | sonnet |
| DOCS-6 | Fake managed agent-browser fixture is duplicated verbatim in test-kit and platform-web | inconsistent | medium | high | S | sonnet |
| DOCS-7 | Accepted ADRs name code that does not exist | inconsistent | medium | high | S | opus |
| DOCS-8 | `docs/dependency-graph-findings.md` describes a tree that no longer exists and contradicts the shipped viewer | unneeded | medium | high | S | sonnet |
| DOCS-9 | The provider-integration suite runs twice per CI run | inefficient | medium | medium | S | opus |
| DOCS-10 | Smoke tests run two or three times in a local full check; fixture-cache runs twice in CI | inefficient | low | high | S | sonnet |
| DOCS-11 | Website source is never typechecked by any gate; three TypeScript majors in one repo | inconsistent | low | high | S | sonnet |
| DOCS-12 | Thirteen `docs/evidence` reports are referenced by nothing | unneeded | low | high | S | sonnet |
| DOCS-13 | `examples/README.md` and `examples/sdk/tsconfig.json` lag the SDK surface | inconsistent | low | high | S | sonnet |
| DOCS-14 | `skills/agent-device/SKILL.md` description omits web, Linux, and webOS targets | inconsistent | low | medium | S | sonnet |
| DOCS-15 | Six per-platform coverage smoke tests repeat the same three test bodies | inconsistent | low | medium | S | sonnet |
| DOCS-16 | Stale comment cites a budget that `docs/agents/testing.md` does not contain | inconsistent | low | high | S | sonnet |

### [tooling-ci-config-2.md](findings/tooling-ci-config-2.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| TOOL2-1 | `build-xcuitest-apple.sh` cleans the wrong directory for iOS, and deletes any override path that the daemon refuses to delete | broken | medium | high | S | opus |
| TOOL2-2 | the nightly concurrency torture lane sweeps the same 5000 seeds every night | inefficient | medium | high | S | sonnet |
| TOOL2-3 | the full replay suites have had no automatic owner since 2026-07-24 | unneeded | medium | high | L | opus |
| TOOL2-4 | a failed `git diff` makes the PR mutation lane select nothing and pass | broken | medium | high | S | sonnet |
| TOOL2-5 | the Android SDK install step exists in six copies that disagree on error handling, and build-tools `36.0.0` is written nine times | inconsistent | medium | high | M | sonnet |
| TOOL2-6 | 43 retired-handler path entries and three regexes in the layering gate cannot fire without R81 firing first | unneeded | low | high | S | sonnet |
| TOOL2-7 | logical-module policies forbid imports into three directories that do not exist | unneeded | low | high | S | sonnet |
| TOOL2-8 | the changed-line coverage gate and the CRAP gate disagree on which report they trust and on what is instrumented | inconsistent | low | medium | M | sonnet |
| TOOL2-9 | `test-app-build-cache.yml` carries conditions and a runner fallback that can never apply | unneeded | low | high | S | sonnet |
| TOOL2-10 | five workflows repeat the iOS runner build stanza and its pins, held together by comments | inconsistent | low | high | M | sonnet |
| TOOL2-11 | one unreadable baseline artifact aborts the whole nightly perf comparison | broken | low | high | S | sonnet |
| TOOL2-12 | the fuzz crash handler can crash before it writes the envelope it exists to write | broken | low | high | S | sonnet |
| TOOL2-13 | `pnpm depgraph affected` claims parity with `check:affected` but passes different inputs, and keeps a branch for a manifest that now exists | inconsistent | low | high | S | sonnet |
| TOOL2-14 | `scripts/ios-snapshot-benchmark/` is a one-off evidence harness whose gate closed on 2026-09-21 | unneeded | low | medium | M | sonnet |
| TOOL2-15 | both asset-release workflows paste a dispatch input into shell, and one sets up Node it does not use | broken | low | medium | S | sonnet |
| TOOL2-16 | `conformance-regenerate.yml` prints the repository commit as the Maestro version | broken | low | high | S | sonnet |
| TOOL2-17 | `conformance-differential.yml` has two copies of its main step that differ by one argument | unneeded | low | high | S | sonnet |
| TOOL2-18 | both `xctest-nightly` matrix legs build the runner on a cold cache, although a comment says only one pays | inefficient | low | medium | S | sonnet |
| TOOL2-19 | `package-android-helper.sh` re-declares what `build-android-helper.sh` already reports | inconsistent | low | high | S | sonnet |
| TOOL2-20 | small defects in the shell build scripts | broken | low | high | S | sonnet |
| TOOL2-21 | scheduled lanes share a cancel-in-progress group with manual dispatches on the same ref | broken | low | medium | S | sonnet |
| TOOL2-22 | comment and structure drift in the layering tooling | inconsistent | low | high | S | sonnet |

### [tooling-ci-config.md](findings/tooling-ci-config.md)

| ID | Finding | Category | Sev | Conf | Effort | Model |
| --- | --- | --- | --- | --- | --- | --- |
| TOOL-1 | 358 of 403 TypeScript files under `scripts/` are never type-checked; a direct `tsc` run reports ~190 errors | broken | high | high | L | opus |
| TOOL-2 | `own:public-surface` selection maps `package.json` exports to source paths that do not exist | broken | medium | high | S | sonnet |
| TOOL-3 | `.changeset/` holds 27 tracked files that no tool reads and nothing ever deletes | unneeded | medium | high | S | sonnet |
| TOOL-4 | `pnpm check` (the "full" local gate) skips four Vitest projects and several cheap CI gates | inconsistent | medium | medium | M | opus |
| TOOL-5 | CI runs the provider-integration suite twice on every PR | inefficient | medium | medium | S | sonnet |
| TOOL-6 | `tsdown.config.ts` keeps two chunk groups whose source paths no longer exist | unneeded | medium | high | S | sonnet |
| TOOL-7 | device-lane selection and `check:affected` disagree on rename handling | inconsistent | medium | medium | S | sonnet |
| TOOL-8 | `scripts/lib/bench-host.test.ts` runs in no lane | broken | low | high | S | sonnet |
| TOOL-9 | `test:maestro-compat` filters on a file that moved | broken | low | high | S | sonnet |
| TOOL-10 | `.fallowrc.json` exempts two exports that no longer exist | unneeded | low | high | S | sonnet |
| TOOL-11 | `scripts/help-conformance-sample-outputs.d.mts` is out of date with its `.mjs` | inconsistent | low | high | S | sonnet |
| TOOL-12 | three device lanes install all dependencies before they decide to skip | inefficient | low | medium | M | opus |
| TOOL-13 | `docs.yml` uses two jobs with identical setup for five gates | inefficient | low | high | S | sonnet |
| TOOL-14 | `release.yml` job `mark-released` installs all dependencies to run two builtin-only scripts | inefficient | low | high | S | sonnet |
| TOOL-15 | `deploy.yml` has no timeout, no concurrency group, and an unneeded `pages: write` | broken | low | medium | S | sonnet |
| TOOL-16 | `@types/json-schema` is an unused root devDependency | unneeded | low | medium | S | sonnet |
| TOOL-17 | Stryker HTML report is configured and uploaded but never produced | unneeded | low | high | S | sonnet |
| TOOL-18 | `smithery.yaml` is named as a sync target but nothing reads or checks it | inconsistent | low | medium | S | sonnet |
| TOOL-19 | `test:coverage` and `test:coverage:ci` are the same command | unneeded | low | high | S | sonnet |
| TOOL-20 | six `package.json` scripts have no caller and no documentation | unneeded | low | medium | S | sonnet |
| TOOL-21 | `scripts/check-provider-plugin.mjs` is a pre-push check that no lane and no doc invokes | unneeded | low | medium | M | sonnet |
| TOOL-22 | platform coverage-manifest tests run in the Integration job and again in each device lane | inefficient | low | high | S | sonnet |
| TOOL-23 | one `oxlint.config.ts` line-cap entry is obsolete | unneeded | low | medium | S | sonnet |
| TOOL-24 | stale coverage exclusion and stale workflow names in tooling comments | inconsistent | low | high | S | sonnet |
| TOOL-25 | workflow step names that do not describe the step | inconsistent | low | high | S | sonnet |
| TOOL-26 | several pinned actions are one or more majors behind and run on the Node 20 action runtime | broken | low | low | S | sonnet |
| TOOL-27 | tooling files carry long incident-history comments that the working rules exclude | inconsistent | low | medium | M | sonnet |
