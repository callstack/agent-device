# ARUN2 audit: `packages/apple-runner/` + native `apple/`, second pass

## Coverage

This pass covers what the ARUN report listed under "Not reached". It does not repeat ARUN-1..21.

Read fully (TS, about 6.5k lines):
- `runner-lease.ts`, `runner-artifact.ts`, `runner-artifact-manifest.ts`, `runner-artifact-env.ts`, `runner-lifecycle.ts`, `runner-disposal.ts`, `runner-adoption.ts`, `runner-cache.ts`, `runner-cache-metadata.ts`, `runner-cache-retention.ts`, `runner-cache-trim.ts`, `runner-retention.ts`, `runner-io.ts`, `runner-process-launch.ts`, `runner-recycle-ledger.ts`, `runner-usbmux.ts`, `runner-usbmux-protocol.ts`, `host.ts`.

Read in part (TS): `runner-startup-transport.ts` (lines 1-330), `runner-session.ts` (start, publish and reuse sections), `apple-runner-platform.ts` (profiles and hints).

Read fully (native, about 2.6k lines):
- Swift: `RunnerTests+ScreenRecorder`, `RunnerTests+TextTyping`, `RunnerTests+GestureExecution`, `RunnerAppScreenCapture`, `RunnerSelectorMatchPolicy`, `RunnerStringNormalization`.
- Objective-C: `RunnerSynthesizedTextEntry.m`, `RunnerSynthesizedGesture.m`, `RunnerSimulatorEdgeTouch.m`, `RunnerObjCExceptionCatcher.m`.

Read in part (native): `RunnerTests+SynthesizedCommitDeadline.swift`, `RunnerTests+SynthesizedTextEntry.swift` (lines 30-70), the selector and record sections of `RunnerTests+Interaction.swift`, `+CommandExecution.swift` and `+CommandDispatch.swift`, `apple/fold-helper/Fold.m` (lines 1-80).

Mechanical passes:
- Swift tests: a scan of every `func test*` body in the 102 test files under `apple/` for a body with no assertion call. One hit, and it is a valid throwing test.
- TS tests (`packages/apple-runner/src/__tests__`, 101 files, 26k lines): scans for `.skip`/`.only`/`.todo`, files with no assertion, fixed sleeps, and truthiness-only assertions. Three files were opened to check hits.
- Leftover-marker grep (`TODO`, `FIXME`, `DEBUG-`) over `apple/` and `packages/apple-runner/src`.

Not reached:
- Objective-C: `RunnerAXSnapshotBridge.m` (881 lines), `RunnerXCTestEventBridge.m` (555), `RunnerSnapshotBridge.m` (309), all of `apple/snapshot-bridge/*.m` (about 1.2k), `AgentDeviceRunnerApp.m`, the rest of `Fold.m`.
- Swift: `RunnerTests+TextEntry` (798), `+SynthesizedInteraction` (866), most of `+SynthesizedTextEntry` (580), `+TextEntryFocus`, `+TextEntryReadiness`, `+TextInputProbe`, `+ScrollDragExecution`, `+SynthesizedGesturePolicy`, `+Keyboard`, `+Alert`, `+SystemModal`, `+Navigation`, `+TvRemote`, `+SequenceExecution`, `RunnerScrollViewportPolicy`, the rest of `recording-overlay.swift`, `recording-frames.swift`, `AudioProbe.swift`, `BackgroundInteraction.swift`.
- TS: `runner-start-budget.ts`, `runner-sequence.ts`, `runner-icon.ts`, `runner-macos-products.ts`, `runner-xctestrun-products.ts`, `runner-launched-session.ts`, `runner-provider.ts`, `runner-session-types.ts`, the second half of `runner-startup-transport.ts`.
- Tests were only scanned, not read. No test was audited line by line.

Rough share of the remaining slice read in this pass: 45% of the TS production source that ARUN did not reach, 15% of the native production source that ARUN did not reach.

Negative results:
- Test hygiene scans are clean. No `.skip`, `.only` or `.todo`. The one TS test file with no `expect`/`assert` (`runner-command-traits-queue-routing.test.ts`) asserts by `throw`. The one Swift test with no `XCTAssert` (`testFixedSeedRegularPresentationMaintainsCumulativeClipInvariant`) asserts by a throwing call. Fixed sleeps total under 1 s across the package.
- The lease code resolves and verifies the runner pid before each signal (`runner-lease.ts:785-814`). Adoption verifies the pid before and after the probe (`runner-adoption.ts:233`, `:244`).
- The usbmux client has no finding worth a row. It opens two usbmuxd connections per command (ListDevices, then Connect), both on a local unix socket.
- `ScreenRecorder` start, append and stop are serialized by one lock, and a tick that races `stop()` is dropped. No finding.
- `RunnerSynthesizedTextEntry.m`, `RunnerSynthesizedGesture.m` and `RunnerSimulatorEdgeTouch.m` check every private selector before they call it, catch `NSException`, and release the one CF object they own. No finding.

## Answer to the open question from the selectors slice

They disagree. The Swift direct-selector path is case-insensitive only. It does not collapse whitespace, it does not trim the element side, and its `text` key has a different meaning. See ARUN2-2.

## Findings

### ARUN2-1: Local runner disposal signals `child.pid` without checking that the child is still that process
- Category: broken
- Severity: medium     Confidence: medium (the code path is certain; the trigger needs a recycled pid, which is rare)
- Evidence:
  - `packages/apple-runner/src/runner-disposal.ts:468-486`. `terminate` reads `local.child.pid` and calls `killRunnerProcessTree`. The default branch (`:478`) sends SIGTERM with no liveness check. The graceful branch (`:470`) and the escalation (`:483`) guard only with `isRunnerProcessTreeAlive(pid)`, which is `isProcessAlive(pid) || isProcessGroupAlive(pid)` (`:334-337`) and is true for any process that now holds the pid. No branch reads `local.child.exitCode`.
  - `killRunnerProcessTree` (`:369-382`) then does `process.kill(-pid)`, `process.kill(pid)` and `/usr/bin/pkill -<SIG> -P <pid>`. A recycled pid loses its process, its group and its children.
  - A session whose `xcodebuild` exited stays registered until the next command for that device, because a dead process is only detected by the next `ensureRunnerSession` (comment at `runner-lifecycle.ts:435-437`). The gap can be hours. `disposeRunnerGeneration` (`runner-disposal.ts:96-101`) then calls `terminate` unconditionally after the graceful shutdown fails.
  - The provider-launched path has the guard this path lacks: `runner-launched-session.ts:77` reads `if (!observation.exited) await launch.terminate()`.
  - The lease path treats the same hazard as a known incident: `runner-lease.ts:737-746` cites #1596 and `resolveVerifiedLeaseRunnerPid` (`:785-800`) refuses a pid whose start time changed.
  - An adopted runner is worse off. `watchDetachedRunnerProcess` (`runner-adoption.ts:450-465`) sets `exitCode` from `isProcessAlive(pid)` on a 1 s poll, so a pid recycled inside one poll interval never reads as exited.
- Fix: in `observeLocalRunnerLaunch`, make `terminate` return early when `local.child.exitCode !== null || local.child.signalCode != null`. Before each `killRunnerProcessTree` call, verify identity with `isLeaseRunnerProcessIntact(local.lease, pid)`; the lease already records `runnerStartTime`. Touches `runner-disposal.ts` only.
- Effort: S
- Model: opus (process signalling, concurrency with the exit observer)
- Verify: new case in `packages/apple-runner/src/__tests__/runner-disposal.test.ts`: a session whose `child.exitCode` is 0 and whose pid is reported alive by the test host is disposed, and `signalPidsBestEffort`, `signalProcessGroupBestEffort` and the `pkill` mock are not called. Run `pnpm vitest run packages/apple-runner/src/__tests__/runner-disposal.test.ts packages/apple-runner/src/__tests__/runner-adoption.test.ts`.

### ARUN2-2: The Swift direct-selector path does not match the way `packages/selectors` does
- Category: inconsistent
- Severity: medium     Confidence: high (the three differences), medium (user-visible effect: the daemon's handling of a runner `found: false` was not traced, it is outside this slice)
- Evidence:
  - TS: `packages/selectors/src/internal/match.ts:58-60` compares `normalizeText(value) === normalizeText(query)`. `normalizeText` (`packages/selectors/src/internal/find.ts:161-163`) is `trim().toLowerCase().replaceAll(/\s+/g, ' ')` and runs on both sides.
  - Swift: `apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Interaction.swift:209-225` trims only the ends of the query, then builds `NSPredicate(format: "label ==[c] %@", value)` (and the same for `identifier` and `value`).
  - Difference 1, whitespace: an element labelled `"Title\nSubtitle"` or `"Save  Draft"` matches `label="Title Subtitle"` in TS and does not match in Swift.
  - Difference 2, element side: the predicate compares the raw attribute, so a label with leading or trailing whitespace matches in TS and not in Swift. `queryElement` trims the label for its output (`:390`) but not for the match.
  - Difference 3, `text` key: Swift uses `label ==[c] %@ OR identifier ==[c] %@ OR value ==[c] %@` (`:222`). TS matches `extractNodeText(node)`, which is the first non-empty of label, value, identifier (`packages/contracts/src/snapshot-text.ts:70-77`). An element with label "Submit" and identifier "save" matches `text=save` in Swift and does not match in TS.
  - Callers: `tap` with `selectorKey` (`RunnerTests+CommandExecution.swift:58-73`, Maestro non-hittable fallback route only, per `packages/daemon/src/core/interaction/internal/interaction-touch-direct-ios-eligibility.ts:20-37`) and `querySelector`, which backs `get`/`is`/`wait` (`RunnerTests+Interaction.swift:372-383`).
- Fix: normalize in one place on the Swift side. Add a pure `RunnerSelectorTextNormalization.normalized(_:)` (trim, lowercase, collapse `\s+` to one space) next to `RunnerSelectorMatchPolicy.swift`. Keep the `NSPredicate` as a coarse prefilter (`CONTAINS[c]` on the first word of the query), then filter candidates in Swift with the normalized equality. For `text`, apply the label, value, identifier precedence of `extractNodeText`. Add a golden parity table shared with the TS matcher, as `TapPointPolicy` already does.
- Effort: M
- Model: opus (device behaviour, changes which element a tap resolves)
- Verify: new `UnitTests/RunnerSelectorTextNormalizationTests.swift` over the parity table; a TS twin test in `packages/selectors` reading the same table. Then `pnpm check:xctest-selection` and the lead's Apple unit lane.

### ARUN2-3: A runner cache hit hashes every product file twice, synchronously
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence:
  - `runner-artifact.ts:598-601` calls `evaluateExistingXctestrun`, which calls `validateRunnerCacheArtifactManifest` (`runner-cache.ts:336-337`). That walks every product root and runs `digestFile` on each leaf (`runner-artifact-manifest.ts:559-603`).
  - On `reuse_ready`, `tryReuseExistingXctestrun` (`runner-artifact.ts:756-766`) calls `writeRunnerCacheMetadataForArtifacts`, which calls `buildRunnerCacheArtifactManifest` (`runner-cache.ts:173-178`). That walks the same roots and runs `digestFile` on each leaf again (`runner-artifact-manifest.ts:333-367`), then rewrites the metadata file.
  - `digestFile` is `fs.readFileSync` plus sha256 (`:385-397`). Both passes block the daemon event loop on every runner start, for a product tree the file's own header puts at "tens of MB".
  - On iOS, tvOS and visionOS nothing changes between the two passes. `repairMacOsRunnerProductsIfNeeded` is the only step that can change products, and only on macOS. The rewrite is otherwise needed only for its mtime, which eviction reads as "last used" (`runner-cache-retention.ts:71`, `:88-94`).
- Fix: in `tryReuseExistingXctestrun`, rebuild the manifest only when the macOS repair reported a change. Otherwise refresh the mtime with `fs.utimesSync(resolveRunnerCacheMetadataPath(derived), now, now)`. Separately make `digestFile` stream with `fs.createReadStream` so the remaining pass does not block the loop. Touches `runner-artifact.ts`, `runner-artifact-manifest.ts`, `runner-macos-products.ts` (return whether it repaired).
- Effort: M
- Model: opus (the manifest is the reuse authorization; the macOS repair path must still certify the bytes it changed)
- Verify: `pnpm vitest run packages/apple-runner/src/__tests__/runner-artifact-reuse.test.ts packages/apple-runner/src/__tests__/runner-artifact-manifest.test.ts packages/apple-runner/src/__tests__/runner-cache-retention.test.ts`, plus a new case asserting a cache hit on an iOS simulator reads each product file once and still advances the metadata mtime.

### ARUN2-4: `[DEBUG-1874]` investigation logging still ships in the runner
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: four `NSLog` sites carry an issue-number debug tag instead of the `AGENT_DEVICE_RUNNER_*` marker every other runner log line uses.
  - `apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+SynthesizedTextEntry.swift:55-58` (one line per synthesized post).
  - `RunnerTests+SynthesizedCommitDeadline.swift:81`, `:91-95`, and `:102-124` (`commitCadenceLogLine`/`logCommitCadence`, one line per poll, every 200 ms for up to 10 s per `fill`).
  - A repo-wide grep for `DEBUG-1874` in `*.ts`, `*.md` and `*.mjs` finds no reader. The only other reference is a unit test that pins the string (`UnitTests/RunnerTests+TextEntryPolicyTests.swift:863-868`).
  - `test/repo-guards/apple-runner-log-redaction.test.ts` guards the content of the poll line, so the line is value-free. It is still per-poll noise in `runner.log`.
- Fix: delete the two wait lines and the post line. Either delete `logCommitCadence` and its test, or keep one summary line per wait under an `AGENT_DEVICE_RUNNER_TEXT_ENTRY_COMMIT` marker and update the redaction guard to that name.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run test/repo-guards/apple-runner-log-redaction.test.ts`; runner unit lane (`TextEntryPolicyTests`); `grep -rn "DEBUG-" apple` is empty.

### ARUN2-5: Three kill ladders send their signals back to back, so the gentle rungs do nothing
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `runner-disposal.ts:156-158` (`stopPrepProcessList`): SIGTERM, then SIGKILL with nothing between them but the `pkill` spawn. The doc comment at `:129-134` says the prep build gets "the tree-kill escalation the sessions get". The session path waits `RUNNER_STOP_WAIT_TIMEOUT_MS` between the two (`:478-484`).
  - `:117-120` (`abortRunnerSessionsAndPrepProcesses`) and `:474-476` (`options.abort`): SIGINT, SIGTERM, SIGKILL in a tight loop.
  - Each rung costs one `/usr/bin/pkill` process spawn (`:378`). A `xcodebuild build-for-testing` that receives SIGKILL a few milliseconds after SIGTERM gets no time to release its build-system lock.
- Fix: decide one rule. Either wait a short bounded time for exit between rungs (reuse `waitForRunnerLaunchExit` on the child's `close`), or send only SIGKILL where no grace is intended and correct the comment. Touches `runner-disposal.ts`.
- Effort: S
- Model: opus (teardown timing feeds the close-path budgets in #3220)
- Verify: `pnpm vitest run packages/apple-runner/src/__tests__/runner-disposal.test.ts packages/apple-runner/src/__tests__/runner-session-close-prep-fence.test.ts`.

### ARUN2-6: The cache lock and cache eviction spawn `ps` synchronously where the lease code uses a cached value
- Category: inefficient
- Severity: low     Confidence: high
- Evidence:
  - `runner-cache.ts:131-135`. `acquireRunnerXctestrunCacheLock` calls `readProcessStartTime(process.pid)` on every acquire. That is a synchronous process-table read (`packages/host-kit/src/internal/host-process.ts:144-146`; the same file says at `:163-164` that the synchronous form "blocks the event loop").
  - `runner-lease.ts:37-41` caches the same value in `runnerOwnerStartTime()` and uses it for the lease lock (`:208`).
  - `runner-cache-retention.ts:99` takes the lock once per eviction candidate, and `:109-112` calls `listActiveRunnerLeaseArtifacts()` once per candidate. That re-reads every lease file and runs `classifyOwnerLiveness` once or twice per lease (`runner-lease.ts:576-590`), each a synchronous process-table read.
- Fix: use `runnerOwnerStartTime()` in `acquireRunnerXctestrunCacheLock`. In `evictStaleRunnerCaches`, keep the per-candidate lease read (the comment at `:107` needs it under the lock) but pass one host process snapshot for all leases through `classifyOwnerLivenessFromObservation`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/apple-runner/src/__tests__/runner-cache-retention.test.ts packages/apple-runner/src/__tests__/runner-cache.test.ts`.

### ARUN2-7: The session `.json` plist intermediate holds the listener token for the whole session and is tracked through four types
- Category: unneeded
- Severity: low     Confidence: medium (no reader found by grep; an out-of-repo consumer of the lease file is possible)
- Evidence: `runner-artifact-env.ts:144-163` writes `AgentDeviceRunner.env.<suffix>.json` only as the input of `plutil -convert xml1`. Nothing reads it afterwards: a grep for `jsonPath` in `packages/apple-runner/src` and `packages/platform-apple/src` finds only pass-through and `cleanupTempFile` (`runner-disposal.ts:252`, `runner-lease.ts:733`). The path is still a required lease field (`runner-lease.ts:80`, `:130-133`, `:662`), a field of `LocalRunnerLaunchResources` (`runner-disposal.ts:445`), an input of `launchLocalRunner` (`runner-process-launch.ts:145`), and is copied on adoption (`runner-adoption.ts:417`, `:428`). The comment at `runner-artifact-env.ts:143` notes the file carries the runner's listener token.
- Fix: feed the JSON to `plutil -convert xml1 -o - -` on stdin, or delete the file right after the conversion. Then drop `jsonPath` from `LocalRunnerLaunchResources` and `launchLocalRunner`. Keep reading `jsonPath` from an on-disk lease as optional, and delete that file on cleanup, until releases that wrote it are out of support.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; `pnpm vitest run packages/apple-runner/src/__tests__/runner-xctestrun.test.ts packages/apple-runner/src/__tests__/runner-adoption.test.ts packages/apple-runner/src/__tests__/runner-disposal.test.ts`.

### ARUN2-8: Platform-hint scoring in `findXctestrun` cannot change the result in the keyed cache layout
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: `runner-artifact.ts:851-878` scores candidates by substring hints on the whole path, including a fixed `-5000` for any path containing `/macos/`.
  - The only production caller is `:685`, which passes the keyed `derived` directory. A key holds one platform and device kind (`runner-cache-metadata.ts:136-158`), and a metadata mismatch cleans the directory before the build (`runner-artifact.ts:617-620`).
  - For a macOS device every candidate lies under `derived/macos/cache-…` (`apple-runner-platform.ts:91-94`), so the `/macos/` penalty and the `macos` preferred hint apply to all candidates equally.
  - The one rule that does separate candidates is the `agentdevicerunner.env.` penalty (`:856-858`), because session xctestruns are written beside the built one (`runner-artifact-env.ts:94`).
- Fix: reduce `scoreXctestrunCandidate` to the session-file rule plus the mtime tiebreak. Delete `resolveRunnerXctestrunHints` and the `xctestrunHints` tables in `apple-runner-platform.ts` if no other caller remains.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/apple-runner/src/__tests__/runner-xctestrun.test.ts` (the two hint tests at `:109` and `:167` are rewritten or removed); `pnpm check:production-exports`.

### ARUN2-9: `packageVersion` is written to the cache metadata and never read
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `runner-cache-metadata.ts:138` computes `packageVersion: readVersion(projectRoot)` in `resolveExpectedRunnerCacheMetadata`, which runs on every runner command (see ARUN-5). `comparableRunnerCacheMetadata` (`:190-194`) strips it before the comparison and before the cache key. A grep for `packageVersion` in `packages/apple-runner/src`, `packages/platform-apple/src` and `scripts` finds only these lines and the type at `:52`.
- Fix: drop the field from `RunnerXctestrunCacheMetadata` and from the resolver, or keep it and say in the type comment that it is for a human reading the file. If it is dropped, simplify `comparableRunnerCacheMetadata`.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; `pnpm vitest run packages/apple-runner/src/__tests__/runner-cache-metadata.test.ts`.

### ARUN2-10: A manifest read failure is reported as `file_too_large`
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `runner-artifact-manifest.ts:595-598`. `validateManifestedFile` maps any `null` from `digestFile` to `{ reason: 'file_too_large', size: stat.size }`. `digestFile` (`:385-397`) returns `null` for an oversized file and also for any read error (EACCES, EIO, a file removed between `lstat` and read). The writer side reports the same two cases as `root_unusable` (`:352-358`). The reason reaches the rebuild diagnostic through `emitRunnerXctestrunRebuildDecision` (`runner-cache.ts:359-370`), so a permission problem is logged as a size problem.
- Fix: make `digestFile` return a typed failure (`too_large` or `unreadable`) and map `unreadable` to `root_unusable` on the reader side.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/apple-runner/src/__tests__/runner-artifact-manifest.test.ts`, with a new case for an unreadable product file (mode 000).

### ARUN2-11: Orphaned doc block in `runner-lease.ts`
- Category: inconsistent (comment placement)
- Severity: low     Confidence: high
- Evidence: `runner-lease.ts:737-747` is a JSDoc block that describes `resolveVerifiedLeaseRunnerPid` ("Only return the pid when the live process is provably still the leased runner. Callers must resolve immediately before each signal"). It sits directly above a second JSDoc block (`:748-752`) and the unrelated export `isLeaseRunnerProcessIntact` (`:753`). The function it describes is at `:785`, after `repairSimulatorAccessibilityAfterRunnerExit`. This block states the constraint that ARUN2-1 shows the disposal path does not follow.
- Fix: move the block to `:785`.
- Effort: S
- Model: sonnet
- Verify: review only; `pnpm format`.
