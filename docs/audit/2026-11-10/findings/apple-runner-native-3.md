# ARUN3 audit: native `apple/`, third pass

## Coverage

This pass covers native code that ARUN and ARUN2 listed under "Not reached". It does not repeat ARUN-1..21 or ARUN2-1..11.

Paths below are relative to `apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/` unless they start with `apple/` or `packages/`.

Read fully, line by line (about 9.3k lines):
- Objective-C, runner: `RunnerAXSnapshotBridge.m` (881), `RunnerXCTestEventBridge.m` (555), `RunnerSnapshotBridge.m` (309).
- Objective-C, `apple/snapshot-bridge/`: `SnapshotBridge.m`, `SnapshotBridgeCapture.m/.h`, `SnapshotBridgeRuntime.m`, `SnapshotBridgeRequest.m/.h`, `SnapshotBridgeSurfaceHosts.m/.h`, `ForegroundApplicationGeometry.h`.
- `apple/fold-helper/Fold.m` (267).
- Swift, runner: `RunnerTests+TextEntry`, `+SynthesizedInteraction`, `+SynthesizedTextEntry`, `+TextEntryFocus`, `+TextEntryReadiness`, `+TextInputProbe`, `+TextEntryConfirmation`, `+TypeExecution`, `+Keyboard`, `+Alert`, `+AlertObservation`, `RunnerAlertVerification`, `+SystemModal`, `+BlockingSystemModalResolution`, `+ScrollDragExecution`, `+ScrollGesture`, `+SynthesizedGesturePolicy`, `+SnapshotBridge`, `+Exceptions`.
- Swift, `apple/snapshot-presentation/Sources`: `AlertSurface`, `ModalScopePair`, `ModalSurface`, `PresentedSurface`, `SnapshotPresentedSurface`, `SnapshotGeometry`, `SnapshotKeyboardSurface`, `SnapshotPresentationInvariant`, `SnapshotPresentationFailure`, `SnapshotVisibilityFoldProjection`, `SnapshotCoordinateSpace`, `SnapshotPresentationConformance/main.swift`.

Read in part, to trace call paths: `RunnerTests+CommandExecution.swift` (tap, type, swipe, keyboard cases), `RunnerRequestPanel.swift`, `RunnerTests+Interaction.swift` (window and app-frame helpers), `RunnerTests+Lifecycle.swift:420-500`, `RunnerTests+TextTyping.swift:165-222`, `RunnerSynthesizedGesture.m:288-312`.

Not reached: `SnapshotModels.swift`, `RecordingSupport/*`, `PrintAlertSurface.swift`, `RunnerTests+Navigation`, `+TvRemote`, `+SequenceExecution`, `+Orientation`, `+ScreenEdgeGesture`, `+PrivateAXPresentation`, `+SnapshotCapturePlan`, `+SnapshotChannelPolicy`, `+SnapshotExecution`, `RunnerScrollViewportPolicy`, `AgentDeviceRunnerApp.m`, `AgentDeviceRunnerAppFixtures.m`, `RecordingScripts/*`, the macOS helper files `BackgroundInteraction`, `AudioProbe`, `GhostCursor`, `AppWindowScreenshot`, and every test file (tests were used only to check whether a symbol has a production caller).

Rough share: with ARUN and ARUN2, about 75% of the native production source under `apple/` is now read. Nothing was built or run; no Xcode is available in this container, so every finding is from source reading.

Negative results:
- `RunnerAXSnapshotBridge.m`: every private selector is checked with `respondsToSelector` before `objc_msgSend`, every KVC read is inside `@try`, the custom-action read is single-flight with a bounded wait, and the deep-extension loop checks the call count, the node budget and the deadline before each request. No retain or over-release problem (ARC only, no CF ownership).
- `RunnerXCTestEventBridge.m`: every private class and selector is required before use; every `valueForKey:` read is inside `RunnerObjCExceptionCatcher`.
- `RunnerSnapshotBridge.m`: the abandon-and-refuse state machine is consistent under its lock. The host maps `bridge-reader-wedged` to a runner-session refusal (`packages/capture-kit/src/snapshot-router/refusal-policy.ts:71`), so a wedged reader is not a silent permanent failure.
- `SnapshotBridgeSurfaceHosts.m`: every `malloc` has a matching `free` on each return path; the argv and envp walks are bounds-checked.
- `SnapshotBridge.m`: frame lengths are bounded before allocation; `MSG_NOSIGNAL` and socket timeouts are set. The host always passes `--idle-timeout 60` (`packages/platform-apple/src/snapshot-source/host.ts:60`).
- `Fold.m`: both CF objects are released on each path; every private selector is checked; waits are bounded (3 s sample wait, 5 s window cap, 60 s keyframe cap). No finding.
- The alert verification loop in `handleAlert` ends: `observeAlert` returns `.deadlineExceeded` after the deadline and `verify` maps it to `.timedOut`. The `.unavailable` to `ALERT_CONFIRMATION_UNAVAILABLE` rule is documented (`website/docs/docs/commands.md:451`).
- `SnapshotCoordinateSpace`, `SnapshotGeometry`, `SnapshotPresentationInvariant` are single-pass and have TS twins named in their comments. No finding.

## Findings

### ARUN3-1: `keyboard enter` with nothing focused reads every element of the app one attribute at a time
- Category: broken (main-thread blocking)
- Severity: medium     Confidence: high (code path), medium (trigger frequency)
- Evidence:
  - `RunnerTests+Keyboard.swift:353-366`. `singleTextEntryElement` runs `app.descendants(matching: .any).allElementsBoundByIndex.filter { element.exists ... element.elementType }`. Each `exists` and each `elementType` on an index-bound handle runs its query again. The runner's own measurement is at `RunnerTests+TextEntry.swift:219-224`: "each query snapshots the whole application, about 90 ms" on a React Native screen.
  - A 200-element screen is 400 round trips. That is 12 to 36 s on the XCTest main thread, against the 30 s command watchdog.
  - Reached from `pressKeyboardReturn` (`:284-286`) when no return key is found and `app.typeText("\n")` records the no-focus issue. The caller is the `keyboardReturn` command (`RunnerTests+CommandExecution.swift:616`).
- Fix: count the four text-input types with typed queries, as `textInputQueries` does (`RunnerTests+TextInputProbe.swift:181-183`): four `allElementsBoundByIndex` calls, stop when the total exceeds one. Use `elementQueries(app:matching:)` so a lit-panel request also works. Touches `RunnerTests+Keyboard.swift` only.
- Effort: S
- Model: sonnet
- Verify: new case in `UnitTests/RunnerTests+KeyboardTests.swift` over a fixture screen with one text field and many other elements; assert the return is delivered. Then `pnpm check:xctest-selection` and the lead's Apple unit lane. On a simulator: `agent-device keyboard enter` on a 200-element screen with no focus returns in under 3 s.

### ARUN3-2: Three error paths raise an `NSException` from Swift, which skips the `defer` that restores `waitForIdleTimeout`
- Category: broken
- Severity: medium     Confidence: medium (Swift runs no cleanup when a foreign exception unwinds its frames; not run here)
- Evidence:
  - `RunnerTests+SynthesizedTextEntry.swift:372-377` and `RunnerTests+TextTyping.swift:186-190`, `:212-216` call `NSException(...).raise()` when the private synthesizer returns `.failed`. All three sit in functions that already `throw`.
  - The `type` command runs inside `withBoundedInteractionIdleTimeoutIfSupported` (`RunnerTests+CommandExecution.swift:425-427`). That wrapper sets the app's `waitForIdleTimeout` to `interactionIdleTimeoutDefault` (1.0 s, `RunnerTests.swift:107`) and restores it in a Swift `defer` (`RunnerTests+Lifecycle.swift:439-446`). A repo-wide grep finds no other write of `waitForIdleTimeout`.
  - The only catcher above is `RunnerObjCExceptionCatcher.catchException` at `RunnerTests+CommandDispatch.swift:237`. The exception crosses `Result { try executeTypeCommand }`, the block passed to XCTest's `_performWithInteractionOptions:block:`, `withoutActuallyEscaping`, and the wrapper. The `defer` does not run, so the app handle keeps a 1 s idle timeout for the rest of the runner session. The same applies to `TextEntryReader`, `withIssueScope` and every retained local on those frames.
- Fix: add a Swift error (for example `TextEntrySynthesisFailure(message:)`) and `throw` it at the three sites. Map it in the dispatcher to the response the caught exception produces now, including the `shouldRetryException` message test at `RunnerTests+Lifecycle.swift:497-501`. Touches the two typing files and `RunnerTests+CommandDispatch.swift`.
- Effort: S
- Model: opus (changes how a failed synthesis reaches session-loss retry)
- Verify: extend `UnitTests/RunnerTests+SynthesizedTextEntryTests.swift` with a synthesizer stub that returns `.raise("x")`; assert the command returns an error response and that `app.value(forKey: "waitForIdleTimeout")` equals its value before the command.

### ARUN3-3: The runner-hosted snapshot-bridge reader has no deadline, so an abandoned read keeps issuing accessibility requests
- Category: broken (unbounded work after timeout)
- Severity: medium     Confidence: high
- Evidence:
  - `RunnerSnapshotBridge.m:14` compiles the reader with `SNAPSHOT_BRIDGE_WATCHDOG_ENDS_PROCESS 0`. The watchdog handler is then empty (`apple/snapshot-bridge/SnapshotBridgeRuntime.m:135-139`), and `maxDurationMs` has no other reader inside `snapshotForProcess` (`:355-513`).
  - `RunnerSnapshotBridgeRead` waits `budgetMs`, then returns `bridge-read-abandoned` (`RunnerSnapshotBridge.m:245-253`). The read itself continues: `captureSnapshotTree` may issue up to `kMaximumRequestsPerCapture = 64` requests (`SnapshotBridgeCapture.m:17`, `:36-41`), plus one `userInteractionEnabledForSnapshot` round trip per dimming view (`SnapshotBridgeRuntime.m:317-321`), plus the tree conversion. No step reads a clock.
  - While it runs, every later read is refused with `bridge-read-in-flight`, then `bridge-reader-wedged` after 5 s (`RunnerSnapshotBridge.m:219-225`). A read that is slow, not hung, therefore blocks the bridge for much longer than its budget and can push the host to the runner-session refusal.
  - The comment at `:182-184` says the accessibility call "cannot be cancelled". That is true for one call, but the reader can stop between calls.
  - In this build each `describe` still creates and cancels a dispatch timer whose handler does nothing (`SnapshotBridgeRuntime.m:123-142`).
- Fix: pass a deadline into the reader. In `snapshotForProcess`, compute `deadline = now + maxDurationMs` and make the `SnapshotElementReader` block return a new `SnapshotCaptureErrorDeadlineExceeded` when the deadline has passed; map it in `captureFailureResponse`. Guard `startRequestWatchdog` with `#if SNAPSHOT_BRIDGE_WATCHDOG_ENDS_PROCESS`. Touches `SnapshotBridgeRuntime.m`, `SnapshotBridgeCapture.h`.
- Effort: S
- Model: opus (shared by the guest bridge and the runner; the guest's kill-on-timeout must stay)
- Verify: new case in `UnitTests/RunnerTests+SnapshotBridgeTests.swift` that drives `captureSnapshotTree` with a reader stub that sleeps past the deadline and counts calls; assert the count stays at 1. Then `pnpm vitest run packages/platform-apple/src/__tests__` for the bridge envelope decoder.

### ARUN3-4: The text-input point probe falls back to a live `element.frame` read, outside issue containment on two of its three routes
- Category: broken
- Severity: medium     Confidence: medium (the recorded-failure effect is taken from the file's own #3060 comments)
- Evidence:
  - `RunnerTests+TextInputProbe.swift:205`: `let frame = candidate.frameOnScreen ?? candidate.element.frame`.
  - `frameOnScreen` is nil for every candidate when the content vector is `.unknown` (`RunnerTests+TextEntry.swift:276-283`). `liveContentTranslation` returns `.unknown` when the window does not resolve (`RunnerTests+TextInputProbe.swift:217-225`), which is the degraded-tree case.
  - The doc on `frameOnScreen` (`RunnerTests+TextEntry.swift:273-275`) says a live `element.frame` of a handle that stopped answering "records a failure (#3060)". `probeTextInputs` holds that issue, but `textInputCandidatesAt` (`RunnerTests+TextInputProbe.swift:23-28`) wraps the same walk in `safely` only, which catches exceptions and not recorded issues. Its callers are `RunnerTests+TextEntryFocus.swift:144`, `RunnerTests+TextEntry.swift:645` and `RunnerTests+Interaction.swift:442`.
  - The fallback also costs one extra query per candidate, although `candidate.snapshot?.frame` holds the same window-local box.
- Fix: in `queryTextInputs`, match on `candidate.frameOnScreen ?? candidate.snapshot?.frame` and skip a candidate that has neither. Run `textInputCandidatesAt` through `containingTextInputProbeIssues`. Touches `RunnerTests+TextInputProbe.swift`.
- Effort: S
- Model: opus (text-entry targeting; a wrong match types into another field)
- Verify: `UnitTests/RunnerTests+TextInputProbeTests.swift` with `contentTranslation: .unknown`; assert a match is found and no issue is recorded. Then the lead's Apple unit lane.

### ARUN3-5: Keyboard return and dismiss lookups issue one XCTest query per label and per container
- Category: inefficient
- Severity: medium     Confidence: high (query count), medium (cost per query)
- Evidence:
  - `RunnerTests+Keyboard.swift:409-423`. `tapKeyboardReturnControl` loops 9 labels and 2 containers (`keyboards.buttons[label]`, `keyboards.keys[label]`) and calls `.exists` on each. With no match that is 18 app queries before the `typeText` fallback. A keyboard whose return key has another label (any non-English locale, "Continue", "Route") takes this path on every `keyboard enter`.
  - `:372-407`. `tapKeyboardDismissControl` loops 3 labels; each runs 3 `.exists` queries and one `descendants(.button).matching(...)` query. An iPhone keyboard has no dismiss key, so every `keyboard dismiss` there pays 12 queries and then returns `UNSUPPORTED_OPERATION`.
  - `dismissKeyboard` then compares frames by PNG bytes (`:269-272`, `:238-255`): at least three full-screen captures and PNG encodes on the main thread, and up to about 14 in 2 s when anything on screen animates.
- Fix: one query per container with a predicate, for example `app.keyboards.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", labels))`, then pick by label order from one `allElementsBoundByIndex` result. For the settle, compare a cheap hash of raw pixel data, not PNG output. Touches `RunnerTests+Keyboard.swift`.
- Effort: S
- Model: sonnet
- Verify: `UnitTests/RunnerTests+KeyboardTests.swift` still passes; on a simulator compare `keyboard enter` and `keyboard dismiss` elapsed time before and after on a screen with a "Go" key and on one with no dismiss key.

### ARUN3-6: A selector tap on a text input that never reports keyboard focus polls for 4 s and taps the field a second time
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence:
  - `RunnerTests+TextEntryReadiness.swift:88-122`. `waitForTextEntryReadinessAfterTap` polls `keyboardFocusConfirmed` for `readinessTimeout` (2.0 s), taps the field again through `retapAt`, then polls 2.0 s more. Called after every selector tap on a text input (`RunnerTests+CommandExecution.swift:112`, `:147`).
  - Each poll is four app-wide reads: `element.exists` and `element.snapshot()` (`RunnerTests+TextEntry.swift:240-252`), then `focused.exists` and `focused.snapshot()` (`RunnerTests+TextEntryReadiness.swift:159-166`). The poll interval is 20 ms, so the loop is back-to-back accessibility work.
  - An input that takes focus without reporting `hasKeyboardFocus` (a web view field, a custom input) pays this on every tap. The second tap lands on a field that is already focused, where iOS shows the edit menu.
  - Related: `waitForTextEntryReadiness` (`:42-67`) reads `app.keyboards.firstMatch` three times per poll (`isKeyboardVisible` reads `exists` and `frame`, `keyboardElementExists` reads `exists` again).
- Fix: in the focus poll, read the focused element's snapshot once and compare it with the target's first read; read the target again only when the focused element changes. In the readiness poll, derive both keyboard facts from one `visibleKeyboardFrame` read. Decide whether the retap is still wanted when the keyboard is already visible. Touches `RunnerTests+TextEntryReadiness.swift`.
- Effort: M
- Model: opus (device behaviour; #1874 and #3237 tuned these waits)
- Verify: `UnitTests/RunnerTests+TextEntryLatencyTests.swift` and `RunnerTests+TextEntryReadinessTests.swift`; on a simulator, time a selector tap on a field inside a `WKWebView`.

### ARUN3-7: `RunnerResolveWindowDisplayID` reads a window's frame without the existence check its own file requires
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `RunnerXCTestEventBridge.m:119-120` and `:202-203` state the rule: "reading a missing window's frame records an XCTest failure, even when the exception is caught" (#2995). `RunnerResolveUsableWindow` (`:131-138`) and `RunnerReadLitPanelCandidate` (`:213-217`) read `exists` first. `RunnerResolveWindowDisplayID` (`:523-528`) reads `frame` directly. It runs at dispatch time for every synthesized gesture that has a window (`RunnerSynthesizedGesture.m:301-303`, `RunnerSimulatorEdgeTouch.m:85`). The window handle can be older than the dispatch: a `sequence` resolves one context for all its steps (`RunnerTests+SynthesizedGesturePolicy.swift:111-119`), and `fill` reuses its `treeContext` after the focus tap (`RunnerTests+TypeExecution.swift:27-32`, `:86`).
- Fix: route `RunnerResolveWindowDisplayID` through `RunnerReadLitPanelCandidate`, which reads `exists`, `frame`, `screen` and `displayID` in the safe order, and map its failure to the same message.
- Effort: S
- Model: sonnet
- Verify: new case in `UnitTests/RunnerTests+XCTestEventBridgeTests.swift` with a stub window whose `exists` is false and whose `frame` getter fails the test when called.

### ARUN3-8: `RunnerCopyLitPanelWindows` has no window cap and runs again for every element query of a lit-panel request
- Category: inconsistent
- Severity: low     Confidence: high (foldable requests only)
- Evidence: `RunnerResolveLitPanelWindow` walks at most `AGENT_DEVICE_MAX_LIT_PANEL_WINDOWS = 8` windows and refuses a truncated list (`RunnerXCTestEventBridge.m:257-263`, `:296`). `RunnerCopyLitPanelWindows` (`:321-338`) walks every window, four XCTest reads each. The booking of the surface is cached per request (`RunnerRequestPanel.swift:74`), but `elementSearchRoots` calls the uncapped walk on every `elementQueries` call (`:96-122`). One `fill` calls it from `textInputQueries` and `boundTextEntryInputQuery` on each resolution and each poll (`RunnerTests+TextInputProbe.swift:181-183`, `RunnerTests+TextEntry.swift:609-617`).
- Fix: keep the lit windows on `litPanelState` beside the booked surface, keyed by the same `LitPanelBookingKey`, and apply the same cap and truncation rule in the walk.
- Effort: S
- Model: opus (foldable routing; a stale root list must not outlive its request)
- Verify: `UnitTests/RunnerRequestPanelTests.swift` with a counter on the window-list stub; assert one walk per request.

### ARUN3-9: The XCTest coordinate-drag path resolves the window, the app frame and the keyboard two to three times
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `executeCoordinateDrag` (`RunnerTests+ScrollDragExecution.swift:128-135`) calls `keyboardAvoidingDragPoints`, then `resolvedDragVisualizationFrame`. The latter calls `resolvedTouchVisualizationFrame` once per endpoint (`RunnerTests+SynthesizedInteraction.swift:293-294`). Each of those calls runs `resolveCoordinateWindow`, `readableAppFrame` (a held `app.frame` read) and `visibleKeyboardFrame` (`:257-269`, `:311-316`, `:336-357`). Both endpoints share one window, so the second set is redundant. `keyboardAvoidingDragPoints` adds a third keyboard read and an `onScreenWindowFrame` read (`:205`, `:220`). This path serves macOS and tvOS drags and the iOS fallback after a failed synthesis, which is when the tree is slowest.
- Fix: resolve one `(appFrame, referenceFrame, keyboardFrame)` value in `executeCoordinateDrag` and pass it to both helpers.
- Effort: S
- Model: sonnet
- Verify: `UnitTests/RunnerTests+ScrollDragExecutionTests.swift` and `RunnerTests+SynthesizedInteractionTests.swift`; the response frames must be unchanged.

### ARUN3-10: Alert title and system-modal reads sit outside the deadline and exception containment the rest of the alert path uses
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence:
  - `alert get` reads its items through `readModalValue(deadline:)`, then reads the title through `safely("ALERT_TITLE", ...)` with no deadline (`RunnerTests+Alert.swift:160-166`). `preferredAlertTitle` can walk `element.descendants(matching: .any).allElementsBoundByIndex` and read `label` and `elementType` live for each element (`:348-351`, `:361-369`). For a dismiss-popup window or an application root that is one round trip pair per element, after the deadline the command was given.
  - `snapshotForBlockingSystemModal` reads `preferredSystemModalTitle(modal)`, `modal.identifier` and `action.elementType` outside `safeMakeSnapshotNode` (`RunnerTests+SystemModal.swift:26`, `:32`, `:44`). Every other read in that function is inside `safely`. A modal that leaves between resolution and these reads raises through Swift frames.
- Fix: read the alert title from one `root.snapshot()` (the `AlertSurface.presentation(of:)` value that `captureAlertPresentation` already builds), bounded by `readModalValue(deadline:)`. Move the three modal reads inside the `safely` block.
- Effort: S
- Model: sonnet
- Verify: `UnitTests/RunnerTests+AlertTests.swift`, `RunnerTests+SystemModalTests.swift`; add a case where the title read is given an expired deadline and the command returns `alertUnresolvedResponse`.

### ARUN3-11: Two refusals on the `fill` and `swipe` paths carry no code, and one is sent after a tap was dispatched
- Category: inconsistent (AGENTS.md: typed reasons)
- Severity: low     Confidence: high
- Evidence:
  - `RunnerTests+TypeExecution.swift:106-112` returns `ErrorPayload(message: "no text input found at the provided coordinates to clear")` or `"no focused text input to clear"` with no code. It is reached after `focusTextInputForTextEntry` has tapped the point (`:81-88`, tap at `RunnerTests+TextEntryFocus.swift:165`). The sibling refusals before the tap are typed (`RunnerWireErrorCode.noTextInputAtPoint`, `.textInputProbeUnavailable`, `:186-205`).
  - `RunnerTests+CommandExecution.swift:442` returns `"swipe is only supported on tvOS"` with no code, after it ran the idle-timeout wrapper and `measureGesture` for a command that can never run on that platform.
  - These are not the pre-dispatch "requires ..." refusals of ARUN-10.
- Fix: give the first one the `noTextInputAtPoint` code, or a new typed code that says a focus tap was dispatched. Return `UNSUPPORTED_OPERATION` for swipe before the wrapper, as `keyboardDismiss` does.
- Effort: S
- Model: sonnet
- Verify: `UnitTests/RunnerTests+CommandExecutionTests.swift` cases for both; `pnpm vitest run packages/apple-runner/src/__tests__/runner-error-classification.test.ts`.

### ARUN3-12: `nodeFromSnapshot` keeps a second depth and node bound that the tree reader already enforces, and its early `break` would drop siblings
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: `captureSnapshotTree` strips children at the depth bound and stops at the node bound (`apple/snapshot-bridge/SnapshotBridgeCapture.m:83-89`, `:116-120`). The tree that reaches `nodeFromSnapshot` therefore has no child at `depth >= maxDepth` and at most `maxNodes` nodes, so `apple/snapshot-bridge/SnapshotBridgeRuntime.m:299-302`, `:329-330` and `:344-348` cannot fire. If the depth branch did fire, `if (*truncated) break;` at `:344` would also end every ancestor's child loop, because `truncated` is one shared flag: later siblings of every ancestor would be lost, not only the deep subtree.
- Fix: delete the three branches and the `maxDepth`, `maxNodes`, `count`, `truncated` parameters of `nodeFromSnapshot`; report `acquisitionTruncated` only. Or keep the guard and remove the `break`.
- Effort: S
- Model: sonnet
- Verify: the bridge conformance lane the lead runs for `apple/snapshot-bridge`; `UnitTests/RunnerTests+SnapshotBridgeTests.swift`.

### ARUN3-13: `ModalSurface` and `ModalScopePair` ship in the runner library with no production caller
- Category: unneeded
- Severity: low     Confidence: low (may be a staged feature for #3565)
- Evidence: `apple/snapshot-presentation/Sources/AgentDeviceSnapshotPresentation/ModalSurface.swift` (141 lines) and `ModalScopePair.swift` (72 lines) are in the one target that `Package.runner.swift:19` builds into the runner. A grep for `ModalSurface`, `ModalScopePair` and `ModalScopeNode` across `apple`, `packages`, `scripts`, `docs` and `website` finds only: package tests, `UnitTests/RunnerModalScopeAcquisition.swift` and `UnitTests/RunnerAXModalScopeCapture.m` (both compiled only under `AGENT_DEVICE_RUNNER_UNIT_TESTS`), and the recording tool (`Sources/RecordingSupport/RawAlertRecording.swift`, `Sources/SnapshotPresentationConformance/PrintAlertSurface.swift`, run by `package.json:229` `print:alert-surface`).
- Fix: move both files to the `RecordingSupport` target, or state in their header which production route will read them. If the runner unit tests must keep `ModalScopePair`, add that target to `Package.runner.swift` for the unit-test configuration only.
- Effort: S
- Model: sonnet
- Verify: `swift test --package-path apple/snapshot-presentation`; `pnpm vitest run test/repo-guards/apple-runner-package-source.test.ts`.

### ARUN3-14: Small leftovers
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `RunnerAXSnapshotBridge.m:633-636` and `RunnerAXSnapshotBridge.h:93`: `customActionReadBlockedCount` is read only by `UnitTests/RunnerTests+AXSnapshotFallbackTests.swift`. The production log line at `:485-489` prints the dispatch count and not this one.
  - `RunnerTests+ScrollDragExecution.swift:234-251`: `scrollKeyboardOccludedResponse` takes `keyboardMinY` and never reads it. The doc block above it (`:227-229`) describes a different function ("Adds the #2500 avoidance evidence to a scroll response") and is joined to this function's own doc.
  - `RunnerTests+TextEntry.swift:3-5`: the header still says "Behavior-preserving extraction from RunnerTests+Interaction.swift (no logic changes)". That is a migration note, and the file has changed since.
  - `RunnerTests+ScrollDragExecution.swift:253-255`: `dragCommandName` derives the command name from the response message string (`message == "scrolled"`); the caller already knows its command.
- Fix: delete the counter or add it to the log line; drop the parameter and the stray doc paragraph; delete the header note; pass the command name.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:xctest-selection`; the lead's Apple unit lane compiles.
