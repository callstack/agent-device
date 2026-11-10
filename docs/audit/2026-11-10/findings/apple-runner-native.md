# ARUN audit: `packages/apple-runner/` + native `apple/`

## Coverage

Slice size: about 100k lines in 421 tracked files (about 26k lines of production source, the rest tests and fixtures).

Read fully (about 30% of production source):
- TS: `runner-contract.ts`, `runner-command-traits.ts`, `runner-command-route.ts`, `runner-source.ts`, `legacy-xctest-device-set.ts`.
- Swift runner: `RunnerTests+Models.swift`, `+CommandExecution`, `+CommandDispatch`, `+CommandJournal`, `+Transport`, `+MainThreadWork`, `+Snapshot`, `+SnapshotAcquisition`, `+SnapshotBackendCapabilities`, `RunnerHttpRequestFraming`, `RunnerAlertButtonChoice`.
- macOS helper: `main.swift`, `SnapshotTraversal.swift`, `MouseClickSchedule.swift`.
- snapshot-presentation: `SnapshotVisibilityFold`, `SnapshotPresentationProjection`, `SnapshotPresentation`, `SnapshotScopePolicy`, both `Package*.swift`.
- `apple/runner/RUNNER_PROTOCOL.md`.

Read in part (about 15%): `runner-exchange.ts`, `runner-command-recovery.ts`, `runner-session.ts`, `runner-transport.ts`, `runner-toolchain-identity.ts`, `runner-failure-diagnostics.ts`, `runner-error-classification.ts`, `index.ts`, `RunnerTests.swift`, `+Interaction`, `+Lifecycle`, `+AXSnapshotFallback`, `recording-overlay.swift`, `RunnerAlertLabelVocabulary`, `apple/snapshot-bridge/README.md`.

Mechanical whole-slice passes:
- Wire-field cross-check: every `Command` and `DataPayload` field in Swift against TS readers and writers repo-wide.
- Heuristic unreferenced-symbol scan over all non-test Swift under `apple/`.
- `jscpd --config .jscpd-native.json apple`, with output sent to the scratchpad.

Not reached:
- TS: `runner-artifact.ts`, `runner-artifact-manifest.ts`, `runner-lease.ts`, `runner-lifecycle.ts`, `runner-disposal.ts`, `runner-adoption.ts`, `runner-cache*.ts`, `runner-startup-transport.ts`, `runner-usbmux*.ts`, and nearly all of `__tests__/` (about 35k lines).
- Swift: text-entry and typing files, synthesized gesture files, the alert files beyond button choice, `SnapshotCapturePlan`, `ScreenRecorder`, all `.m` files (`RunnerAXSnapshotBridge.m`, `apple/snapshot-bridge/*.m`, `apple/fold-helper/Fold.m`), `BackgroundInteraction.swift`, `AudioProbe.swift`, and `UnitTests/`.

Negative results:
- Command names match exactly: 39 on each side (`CommandType` and `RunnerCommand['command']`).
- Every request field that TS declares is read by Swift.
- `fallow-baselines/` holds no apple-runner debt.
- Native duplication is small. jscpd reports 57 clones (620 lines, 1.15%) under `apple/`, and 54 of them are inside test files. The 3 production clones are the two `Package*.swift` manifests (by design), a 9-line block in `recording-overlay.swift`, and a header/implementation prototype pair in `snapshot-bridge`. No cross-target Swift duplication is worth a finding.
- The snapshot-presentation fold and projection are linear single-pass.
- `RunnerIsolationCanary.swift` looks dead but is a positive control compiled by `scripts/build-xcuitest-apple.sh`.

## Findings

### ARUN-1: macOS helper `alert accept/dismiss` picks buttons by substring and by position, so it can press the opposite button
- Category: broken
- Severity: medium     Confidence: high (logic), medium (frequency: only when the dialog has no `AXDefaultButton`/`AXCancelButton`)
- Evidence: `apple/macos-helper/Sources/AgentDeviceMacOSHelper/main.swift:867-879`. `resolveAlertActionButton` lowercases each label, takes the first button whose label `contains` a preferred word, and falls back to `buttons.first` (accept) or `buttons.last` (dismiss).
  - For `accept`, "allow" is the first preference, so a dialog ordered ["Don't Allow", "OK"] presses "Don't Allow".
  - For `dismiss`, "no" is a substring of "Turn On Notifications" and "Allow Notifications", so ["Turn On Notifications", "Skip"] presses the affirmative.
  - The runner twin, `RunnerAlertButtonChoice.swift:18-45`, uses anchored regexes, refuses ties, and never guesses by position. Its header comment explains why a positional guess is unsafe (#3627).
  - `website/docs/docs/commands.md:450` says the helper "keeps its own rules", so the divergence is known but the substring hazard is not.
- Fix: in `main.swift`, replace `contains` with whole-label, case-insensitive matches against the runner's accept and dismiss lists. Refuse with a typed `details.reason` (for example `alert-button-not-found`) instead of `buttons.first`/`buttons.last`. Keep the `AXDefaultButton`/`AXCancelButton` fast path. Update `packages/platform-apple/src/os/macos` to map the new reason, and update `commands.md`.
- Effort: M
- Model: opus (device behaviour, changes what gets pressed)
- Verify: new cases in `apple/macos-helper/Tests/AgentDeviceMacOSHelperTests` for a pure `alertButtonIndex(labels:action:)` function (["Don't Allow","OK"] accept gives index 1; ["Turn On Notifications","Skip"] dismiss gives index 1). Run `swift test --package-path apple/macos-helper`.

### ARUN-2: macOS helper snapshot attributes a wrong `windowTitle` to every element under an untitled window
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `SnapshotTraversal.swift:619` computes `windowTitle = context.windowTitle ?? inferWindowTitle(for: element)`. `inferWindowTitle` (`:734-742`) returns the element's own `AXTitle` first. When the window has no title, `context.windowTitle` is nil (`:298`), so the first titled descendant (say a button titled "Save") reports `windowTitle: "Save"` and passes it to its whole subtree (`:660-666`). The selector engine matches on this field (`packages/selectors/src/internal/match.ts:35`). Each node under such a window also pays 1-2 extra AX round trips.
- Fix: in `appendElementSnapshot`, stop inferring per element. Resolve the window title once in `appendApplicationSnapshot` (`AXTitle` of the window) and for menubar roots. Pass it down unchanged, nil when the window is untitled. Delete `inferWindowTitle`.
- Effort: S
- Model: sonnet
- Verify: `swift test --package-path apple/macos-helper` with a new test over an extracted pure title-propagation function. Manual check: `agent-device snapshot --json` on an untitled macOS window shows no control label as `windowTitle`.

### ARUN-3: macOS helper depth cap is silent on `frontmost-app`, `desktop` and `menubar`
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: `SnapshotTraversal.swift:645-649` sets `state.depthCapped` when children are left out at `maxDepth`. Only `snapshotSessionApp` folds it into `truncated` (`:119`). `snapshotFrontmostApp` (`:204`), `snapshotDesktop` (`:259`) and `snapshotMenuBar` (`:364`, `:405`) return `truncated: state.truncated`. Those surfaces also use the default `maxDepth = 12` (`:9`, `:268`, `:599`) against 48 for `app` (`:11`). A frontmost Electron app (about ten wrapper groups, per the comment at `:10`) loses its content and reports `truncated: false`. `frontmost-app` also skips `enableRemoteAccessibilityTree` (`:107` against `:194-205`).
- Fix: build every `SnapshotBuildResult` through one helper that sets `truncated: state.truncated || state.depthCapped`. Give `frontmost-app` the same depth and the same Chromium enabling as `app`, since both capture one app's tree.
- Effort: S
- Model: sonnet
- Verify: `swift test --package-path apple/macos-helper`. Manual check: `snapshot --surface frontmost-app` on VS Code reports `truncated` or returns web content.

### ARUN-4: Runner non-inline screenshots are never deleted
- Category: broken (resource leak)
- Severity: medium     Confidence: high
- Evidence: `RunnerTests+Lifecycle.swift:127-152` writes `screenshot-<epoch-ms>.png` into the runner container `tmp/` (iOS) or `NSTemporaryDirectory()` (macOS). The only `removeItem` in the runner sources is `RunnerTests+ScreenRecorder.swift:50`. The host copies the file and leaves it: `packages/platform-apple/src/core/screenshot.ts:355-358` (`copyHostFile` on macOS) and `:375-395` (`copySimulatorFileToHost`). Every macOS runner screenshot and every simulator runner-fallback screenshot leaves a multi-megabyte PNG behind for the life of the runner container.
- Fix: in `screenshotResponse(pngData:)`, delete earlier `screenshot-*.png` files in the same directory before writing the new one. One retained file is enough because the host copies before the next command. Alternatively send `inlineScreenshot: true` for macOS (cross-slice, `screenshot.ts:343`).
- Effort: S
- Model: sonnet
- Verify: runner unit test that calls `screenshotResponse` twice and asserts one `screenshot-*.png` remains. Run `pnpm check:xctest-selection`, then the lead's Apple unit lane.

### ARUN-5: Every local runner command re-walks the runner source tree and re-reads Xcode version files synchronously
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `executeRunnerCommand` calls `ensureRunnerSession` per command (`runner-lifecycle.ts:120`, `:332`). For an existing local session this runs `resolveReusableRunnerSession`, which calls `resolveExpectedRunnerCacheMetadata` (`runner-session.ts:512`).
  - `computeRunnerSourceFingerprint` (`runner-source.ts:65-84`) does a recursive `readdirSync` plus one `statSync` per file (214 tracked files in a checkout) plus a sha256 of the stats before it can hit its memo.
  - `requireRunnerToolchainFingerprint` (`runner-toolchain-identity.ts:120-175`) does `readlinkSync`, two `realpathSync`, one `existsSync`, and three `readFileSync` calls, including a parse of the SDK's `SDKSettings.json`.
  - Measured in this container: 2.5 ms per warm fingerprint call on a fast Linux filesystem (51 ms cold), excluding the toolchain reads. All of it blocks the daemon event loop, once per tap, snapshot or wait poll.
- Fix: memoize the resolved `RunnerXctestrunCacheMetadata` per `(projectRoot, platform, device kind, DEVELOPER_DIR)` for a short TTL of 2-5 s, or revalidate only when the session has been idle longer than that. Keep the stat-based invalidation behind it. Touches `runner-cache-metadata.ts`, or only the call site in `runner-session.ts`.
- Effort: S
- Model: opus (a stale-runner decision rides on this; choose the TTL against the Xcode-swap case in #2422)
- Verify: `pnpm vitest run packages/apple-runner/src/__tests__/runner-session-stale-bundles.test.ts packages/apple-runner/src/__tests__/runner-cache-metadata.test.ts`, plus a new test asserting two back-to-back commands stat the tree once.

### ARUN-6: macOS helper snapshot makes about 11 AX round trips per node and a quadratic visited check
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `SnapshotTraversal.swift:609-617` issues separate `AXUIElementCopyAttributeValue` calls per node for role, subrole, title, description, value, identifier, position, size, enabled and selected, then children (`:652`). That is 11 calls, or up to 13 under an untitled window (ARUN-2). With `maxNodes = 1500` that is about 16k synchronous cross-process calls per snapshot. `AXUIElementCopyMultipleAttributeValues` returns all of them in one call. Separately, `:601` runs `state.visited.contains(where: CFEqual)` over an array, which is O(n²) and about 1.1M `CFEqual` calls at the cap.
- Fix: add one `copyAttributes(element, [..])` wrapper over `AXUIElementCopyMultipleAttributeValues` and decode role, subrole, title, description, value, identifier, position, size, enabled, selected and children from its result. Replace `visited: [AXUIElement]` with a `Set` keyed on `CFHash`/`CFEqual`.
- Effort: M
- Model: opus (AX API edge cases: `AXValue` and error placeholders in the result array)
- Verify: `swift test --package-path apple/macos-helper`. Time `agent-device-macos-helper snapshot --surface app --bundle-id com.apple.finder` before and after, and compare node output byte for byte.

### ARUN-7: XCTest query-sweep tier and `querySelector` read live elements one attribute at a time
- Category: inefficient
- Severity: medium     Confidence: medium (per-attribute cost on `XCUIElement` is XCTest behaviour, not measured here)
- Evidence:
  - `RunnerTests+SnapshotAcquisition.swift:661-696` (`flatSnapshotNode`) reads `exists`, `frame`, `label`, `identifier`, `value`, `elementType`, `isEnabled`, `placeholderValue`, two KVC focus keys and `isSelected` from a live `XCUIElement`. Each read is its own resolution.
  - `:591-611` issues 19 separate type queries under a 1 s slice (`RunnerTests+Snapshot.swift:140`), so the tier often ends `deadlineExhausted` on the heavy screens that need it.
  - `RunnerTests+Interaction.swift:386-404` (`queryElement`, which backs `wait`/`is`/`get` polling) does the same nine-attribute read.
  - The same file already has the cheap pattern: `collapsedTabCandidatePredicate` (`:394-409`) copies `XCUIElementAttributes` inside the query. Its comment at `:340` reads "The predicate copies attributes during each query without further round trips".
- Fix: build sweep nodes from the attributes captured by a predicate, as `collapsedTabCandidates` does, or from one `element.snapshot()` per element. Collapse the 19 queries into one `descendants(matching: .any)` with a type-set predicate. Apply the same single-snapshot read in `queryElement`.
- Effort: M
- Model: opus (device behaviour, deadline and abandonment semantics)
- Verify: `RunnerTests+SnapshotTests` and `SnapshotCapturePlanTests` unit lane. On a device, force `preferredBackend` off the tree tier and compare node counts and elapsed time on a long list screen.

### ARUN-8: `aggregatedLabel` re-walks up to four levels of descendants for every unlabeled node
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence: `RunnerTests+SnapshotAcquisition.swift:188-189` calls `aggregatedLabel(for:)` for every node of the tree walk. `:286-297` runs a DFS to depth 4 over `snapshot.children` whenever the node has no label or value. Label-less wrapper chains are the common shape in React Native trees. Each ancestor repeats the walk its child will do again, and a label-less subtree costs the product of the branching factors per node. The walk is bounded only by `regularSnapshotMaxNodes = 50_000` (`RunnerTests+Snapshot.swift:17`). It runs on the XCTest main thread inside the 30 s watchdog.
- Fix: compute the aggregated label bottom-up once. Either a post-order pass that fills a per-snapshot cache keyed by `ObjectIdentifier`, or have the DFS in `recursiveTreeSnapshotAcquisition` carry the first labeled descendant upward.
- Effort: M
- Model: sonnet
- Verify: existing `RunnerTests+SnapshotTests`; output for the conformance fixtures must be identical.

### ARUN-9: Host classifies the runner watchdog timeout by matching Swift error text
- Category: inconsistent (AGENTS.md: typed reasons, no error-text matching)
- Severity: low     Confidence: high
- Evidence: `packages/apple-runner/src/runner-failure-diagnostics.ts:131-137` and `:160-162` test `message.toLowerCase().includes('main thread execution timed out')`. That is the `NSLocalizedDescriptionKey` string at `RunnerTests+MainThreadWork.swift` in `mainThreadExecutionTimeoutError`. The same condition already travels typed as `MAIN_THREAD_TIMEOUT` (`RunnerTests.swift:44`, `:63`) and is read typed elsewhere (`runner-error-classification.ts:716-720`, `isRunnerMainThreadTimeoutError`).
- Fix: have `classifyRunnerFailureError` use `isRunnerMainThreadTimeoutError(error)` and delete `isMainThreadExecutionTimeout`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/apple-runner/src/__tests__/runner-session-response.test.ts packages/apple-runner/src/__tests__/runner-error-classification.test.ts`.

### ARUN-10: Runner argument-validation refusals are typed for some commands and untyped for others
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: 15 refusals of the form `ErrorPayload(message: "<cmd> requires ...")` carry no code. Examples: `RunnerTests+CommandExecution.swift:214` (tap), `:217`, `:240`, `:276`, `:413`, `:431`, `:447`, `:453`, `:458`; `RunnerTests+CommandDispatch.swift:410`, `:416`, `:422`, `:478`, `:488`. Fifteen others carry `code: "INVALID_ARGS"` (for example `CommandDispatch.swift:35`, `:61`, `:80`; `CommandExecution.swift:656`). The host maps only `INVALID_ARGS` to `dispatched: 'no'` (`runner-contract.ts:371-372`). The same "refused before anything ran" case therefore surfaces as `COMMAND_FAILED` with `dispatched: unknown` for tap, drag, longPress, readText, findText, querySelector, swipe, recordStart, activate and terminate.
- Fix: add `code: "INVALID_ARGS"` to every pre-dispatch "requires" refusal through one `invalidArgsResponse(_:)` helper in the runner.
- Effort: S
- Model: sonnet
- Verify: extend `UnitTests/RunnerTests+CommandExecutionTests.swift` with a table over commands asserting `error.code == "INVALID_ARGS"` for empty payloads.

### ARUN-11: macOS helper argument parsing breaks on text equal to a flag and silently defaults bad integers
- Category: broken
- Severity: low     Confidence: high
- Evidence: `main.swift:557-562`. `optionValue` returns the token after the first occurrence of a flag name anywhere in argv, and `withGhostCursor` uses `arguments.contains("--ghost-cursor")` (`:578`). `type --text "--bundle-id" --bundle-id com.x` reads the bundle id as `"--bundle-id"` and fails with "bundle id must use reverse-DNS form". `fill ... --text "--ghost-cursor"` turns the ghost cursor on. Typing `--x`, `--y`, `--text`, `--delay-ms` or `--surface` behaves likewise. Separately, `intOption` (`:591-596`) makes `audio-probe --duration-ms abc` fall back to 10000 without error, while press and type use `validatedIntOption`, which throws.
- Fix: parse argv once into a `[flag: value]` map that consumes values positionally, so a value is never rescanned as a flag. Use `validatedIntOption` for audio-probe.
- Effort: S
- Model: sonnet
- Verify: new helper unit tests over the parser. Run `swift test --package-path apple/macos-helper`.

### ARUN-12: One-sided wire fields
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - (a) `RunnerTests+CommandJournal.swift:171-172` emits `lifecycleCommand` and `lifecycleResponseOk` (declared at `RunnerTests+Models.swift:527-528`). A repo-wide grep finds no TS reader. `runner-command-recovery.ts` reads only `lifecycleState`, `lifecycleResponseJson` and `lifecycleError{Code,Message,Hint}`.
  - (b) `packages/daemon/src/core/recording-gestures.ts:138`, `:161`, `:367` and `packages/contracts/src/screen-recording-runtime.ts:43` produce `contentDirection` on scroll events. The only consumer, `apple/runner/AgentDeviceRunner/RecordingScripts/recording-overlay.swift:36`, decodes it and never reads it. That line is the single occurrence in all Swift.
- Fix: (a) delete both `DataPayload` fields and the two assignments, or start reading `lifecycleCommand` in recovery to assert that the journal entry is for the command that was sent. (b) drop the field from `GestureEvent` in the overlay. Leaving it in the TS event type is harmless.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; runner unit lane (`RunnerTests+CommandJournalTests`, `ModelsTests`).

### ARUN-13: `gestureViewport` returns width and height in fields named `x2` and `y2`
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `RunnerTests+CommandExecution.swift:703` builds `DataPayload(message: "gestureViewport", x: frame.minX, y: frame.minY, x2: frame.width, y2: frame.height)`. The host reads `const width = finiteNumber(result.x2)` at `packages/platform-apple/src/interactions.ts:346`. Everywhere else `x2`/`y2` are end coordinates (drag request and gesture response). `DataPayload` already has `referenceWidth`/`referenceHeight`.
- Fix: return `referenceWidth`/`referenceHeight`, or a dedicated `viewport` rect, and read those in `interactions.ts`. Both ends ship together under the source fingerprint, so no compatibility path is needed.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/platform-apple` (gesture viewport tests); runner unit lane.

### ARUN-14: `RUNNER_PROTOCOL.md` points at the wrong files and the wrong declaration site
- Category: inconsistent (docs against code)
- Severity: low     Confidence: high
- Evidence:
  - `apple/runner/RUNNER_PROTOCOL.md:182` says the daemon reads `runnerMainThreadBusy` in `runner-session.ts`. It is read in `runner-exchange.ts:199-204` and `:244`.
  - `:186` says `resolveRunnerFatalReason` is in `runner-session.ts`. It is at `runner-exchange.ts:544`, and `runner-session.ts` has no such symbol.
  - `:187-190` says wire codes "are declared in `RunnerWireErrorCode`" and names `RUNNER_BUSY`/`RUNNER_WEDGED`. That enum (`RunnerTests.swift:43-55`) has neither. They are string literals at `RunnerTests+CommandDispatch.swift:137`, `:156`.
  - `:158` shows a keyboard-dismiss message that no longer matches `RunnerTests+CommandExecution.swift:599`.
- Fix: correct the three pointers. Move the `RUNNER_BUSY`/`RUNNER_WEDGED` literals into `RunnerWireErrorCode` so the doc and the enum comment at `RunnerTests.swift:32-34` become true.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:doc-links`; grep for the two literals shows only the enum.

### ARUN-15: Dead dispatch branches and a trait mismatch for commands the transport answers off-queue
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `RunnerTests+Transport.swift:312-323` answers `status`, `uptime` and `snapshotBridge` before the journal and command queue, and returns (`:205-219`). `enqueueAdmittedExecution` is the only production path into `executeOnMain`, yet `RunnerTests+CommandDispatch.swift:398-399`, `:465-466` and `:469-470` still handle those three there. `uptime` is classified `.runnerLifecycle` with `isReadOnly: false` (`RunnerTests+Models.swift:326`, `:185`), while TS declares it `readOnly: true` (`runner-command-traits.ts:109`). The drift goes unnoticed because the Swift value is never consulted.
- Fix: remove the three cases from `executeOnMain` and let them fall to the existing "cannot be executed through the prepared command path" refusal at `CommandExecution.swift:48-56`. Classify `.uptime` with `.status` under `runnerCaptureRead`.
- Effort: S
- Model: sonnet
- Verify: runner unit lane (`CommandDispatchTests`, the trait completeness table in `ModelsTests`).

### ARUN-16: Swift symbols that only tests reference
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `RunnerTests+Snapshot.swift:134` `scrollContainerTypes`. Its only reference is `UnitTests/RunnerTests+SnapshotVisibilityFoldTests.swift:192`, which pins it to `SnapshotVisibilityFold.scrollContainerTypeNames`, the constant production actually uses.
  - `RunnerTests+SnapshotBackendCapabilities.swift:35` `hittableSemantics` returns the same literal for every case. `:61` `regularDepthCapability` and the `SnapshotRegularDepthCapability` enum (`:12-19`) are read only by `UnitTests/RunnerTests+SnapshotBackendCapabilitiesTests.swift:58`, `:63`.
- Fix: delete `scrollContainerTypes` and its parity test. For the two capability properties, either delete them with their test rows, or keep them only if the test is the pin against `packages/capture-kit/src/snapshot-quality-backend-capabilities.ts` and say so in a comment.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:xctest-selection`; runner unit lane compiles.

### ARUN-17: Every runner-reported error carries a fabricated `xcodebuild` detail
- Category: unneeded
- Severity: low     Confidence: medium (no reader found by grep; a generic serializer could still echo it)
- Evidence: `runner-contract.ts:495-499`. `buildRunnerResponseError` attaches `xcodebuild: { exitCode: 1, stdout: '', stderr: '' }` to errors that came from a runner HTTP reply, where no xcodebuild process is involved. Greps for `details?.xcodebuild` and `.xcodebuild` find readers only in `__tests__/runner-startup-transport*.test.ts`, which assert the real startup-failure detail built at `runner-startup-transport.ts:570`.
- Fix: delete the block from `buildRunnerResponseError`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/apple-runner`.

### ARUN-18: Checkout runner fingerprint includes files that cannot change the production runner
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence: `runner-source.ts:41` ignores only `.build`, `.swiftpm` and `xcuserdata` under the runner root. `UnitTests/` (every body is under `#if AGENT_DEVICE_RUNNER_UNIT_TESTS`), `RunnerIsolationCanary.swift` (`#if AGENT_DEVICE_RUNNER_ISOLATION_CANARY`) and `AgentDeviceRunnerAppFixtures.m` are therefore hashed. The packager excludes exactly these as non-product (`scripts/package-apple-runner-source.mjs:36-48`). In a checkout, editing a runner unit test invalidates the cached runner and forces a full `xcodebuild build-for-testing` on the next command.
- Fix: share one exclusion list between `runner-source.ts` and the packager, so checkout and packaged fingerprints cover the same product inputs.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/apple-runner/src/__tests__/runner-source.test.ts`, with a new case showing that touching `UnitTests/x.swift` keeps the fingerprint.

### ARUN-19: Comments on the two sides disagree about whether a replayed response is stamped
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `runner-exchange.ts:196-199` says "a recovered or journal-replayed response is written unstamped by design". The runner's `.terminal` replay goes through `jsonResponse`, and the comment at `RunnerTests+Transport.swift:240` says "jsonResponse stamps replayed successes with current occupancy". The code at `:385-390` stamps both `currentUptimeMs` and `runnerMainThreadBusy`. Only the `status`-recovered `lifecycleResponseJson` is unstamped. Behaviour is correct, because the stamp reflects occupancy at replay time. The TS comment and the Swift comment at `Transport.swift:380-384` describe a different rule.
- Fix: reword both comments to say that the journal-stored body is unstamped and that every live HTTP reply, including a `.terminal` replay, is stamped at send time.
- Effort: S
- Model: sonnet
- Verify: review only.

### ARUN-20 (cross-slice, owner `packages/platform-apple`): every macOS helper call re-fingerprints the helper sources and spawns `swift --version`
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `packages/platform-apple/src/os/macos/helper.ts:341-343`. `runMacOsHelper` calls `resolveMacOsHelperCommandPath`, then `ensureMacOsHelperBinary` (`:243-256`), then `computeMacOsHelperFingerprint` (`:211-229`). That last function reads every `.swift` file under `apple/macos-helper` and runs `swift --version`, on every snapshot, press, read and alert, with no memo. It is skipped only with `AGENT_DEVICE_MACOS_HELPER_BIN` or a scoped provider.
- Fix: memoize the resolved helper path per process, keyed on `(packageRoot, max mtime+size)` like `runner-source.ts:57-84`, and compute the swift version once per daemon.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/platform-apple/src/os/macos`, with a new test asserting two helper calls spawn `swift --version` at most once.

### ARUN-21: Legacy `XCTestDevices` redirect restore still ships as public surface
- Category: unneeded (AGENTS.md: remove superseded migration paths)
- Severity: low     Confidence: low (when the redirecting versions were released was not verified; the path guards against simulator-set deletion)
- Evidence: `packages/apple-runner/src/legacy-xctest-device-set.ts:1-74` undoes a symlink that "an older agent-device left". It is exported through `index.ts:379-388` and `packages/platform-apple/src/runner-owner-facade.ts:8`.
- Fix: confirm the last release that created the redirect. If it is outside the support window, delete the file, its test (`__tests__/legacy-xctest-device-set.test.ts`) and the two re-exports. Otherwise add the removal version to the header comment.
- Effort: S
- Model: opus (the decision is risky; the deletion is mechanical)
- Verify: `pnpm typecheck && pnpm check:production-exports`.
