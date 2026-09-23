import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

private final class RunnerSynthesizedSwipeFailureStub: NSObject {
  @objc(synthesizeSwipeWithApplication:resolvedWindow:x:y:x2:y2:durationMs:)
  class func synthesizeSwipe(
    application: XCUIApplication,
    resolvedWindow: Any?,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double
  ) -> String? {
    "forced private synthesis failure"
  }
}

private final class RunnerSynthesizedTapFailureStub: NSObject {
  @objc(synthesizeTapWithApplication:resolvedWindow:x:y:)
  class func synthesizeTap(application: XCUIApplication, resolvedWindow: Any?, x: Double, y: Double) -> String? {
    "forced private synthesis failure"
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testGestureResponseIncludesSynthesizedTapFallbackDiagnostics() {
    let response = gestureResponse(
      message: "tapped",
      timing: (gestureStartUptimeMs: 1, gestureEndUptimeMs: 2),
      fallback: GestureFallback(
        strategy: "xctest-coordinate-tap",
        message: "Runner synthesized coordinate tap is unavailable",
        hint: "Using XCTest coordinate tap fallback."
      )
    )

    XCTAssertEqual(response.ok, true)
    XCTAssertEqual(response.data?.gestureFallback, "xctest-coordinate-tap")
    XCTAssertEqual(
      response.data?.gestureFallbackMessage,
      "Runner synthesized coordinate tap is unavailable"
    )
    XCTAssertEqual(response.data?.gestureFallbackHint, "Using XCTest coordinate tap fallback.")
  }

  func testGestureResponseIncludesMaestroNonHittableFallbackUsage() {
    let response = gestureResponse(
      message: "tapped via non-hittable coordinate fallback",
      timing: (gestureStartUptimeMs: 1, gestureEndUptimeMs: 2),
      frame: .touch(nil),
      maestroNonHittableCoordinateFallbackUsed: true
    )

    XCTAssertEqual(response.data?.maestroNonHittableCoordinateFallbackUsed, true)
  }

  func testCanonicalPlannedGestureResponseOmitsDragFrameAndPreservesDiagnostics() {
    let response = gestureResponse(
      message: "fling",
      timing: (gestureStartUptimeMs: 1, gestureEndUptimeMs: 2),
      frame: .drag(
        DragVisualizationFrame(
          x: 160,
          y: 150,
          x2: 40,
          y2: 150,
          referenceWidth: 200,
          referenceHeight: 300
        )
      ),
      fallback: GestureFallback(
        strategy: "xctest-coordinate-drag",
        message: "Private synthesis unavailable",
        hint: "Using XCTest coordinate fallback."
      )
    )

    let canonical = canonicalPlannedGestureResponse(response)

    XCTAssertEqual(canonical.data?.gestureStartUptimeMs, 1)
    XCTAssertEqual(canonical.data?.gestureEndUptimeMs, 2)
    XCTAssertEqual(canonical.data?.gestureFallback, "xctest-coordinate-drag")
    XCTAssertEqual(canonical.data?.gestureFallbackMessage, "Private synthesis unavailable")
    XCTAssertEqual(canonical.data?.gestureFallbackHint, "Using XCTest coordinate fallback.")
    XCTAssertNil(canonical.data?.x)
    XCTAssertNil(canonical.data?.y)
    XCTAssertNil(canonical.data?.x2)
    XCTAssertNil(canonical.data?.y2)
    XCTAssertNil(canonical.data?.referenceWidth)
    XCTAssertNil(canonical.data?.referenceHeight)
  }

#if os(iOS)
  func testSinglePointerFlingFallsBackToXCTestCoordinateDragWhenPrivateSynthesisFails() throws {
    let selector = NSSelectorFromString(
      "synthesizeSwipeWithApplication:resolvedWindow:x:y:x2:y2:durationMs:"
    )
    guard
      let synthesizedSwipeMethod = class_getClassMethod(RunnerSynthesizedGesture.self, selector),
      let failureStubMethod = class_getClassMethod(RunnerSynthesizedSwipeFailureStub.self, selector)
    else {
      XCTFail("unable to install synthesized swipe failure stub")
      return
    }
    let originalImplementation = method_getImplementation(synthesizedSwipeMethod)
    method_setImplementation(
      synthesizedSwipeMethod,
      method_getImplementation(failureStubMethod)
    )
    app.launch()
    runnerAccessibilityHealth = .healthy
    defer {
      method_setImplementation(synthesizedSwipeMethod, originalImplementation)
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let command = try runnerCommandFixture(
      """
      {"command":"gesture","commandId":"gesture-fling-fallback","gesturePlan":{"topology":"single","intent":"fling","executionProfile":"endpoint-hold","durationMs":100,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":160,"y":150}},{"offsetMs":100,"point":{"x":40,"y":150}}]}]}}
      """
    )

    let response = try executeOnMainPrepared(command: command, activeApp: app)

    XCTAssertTrue(response.ok)
    XCTAssertEqual(response.data?.message, "fling")
    XCTAssertEqual(response.data?.gestureFallback, "xctest-coordinate-drag")
    XCTAssertEqual(response.data?.gestureFallbackMessage, "forced private synthesis failure")
    XCTAssertEqual(
      response.data?.gestureFallbackHint,
      "Private XCTest event synthesis is required for AX-free coordinate drag on iOS; update Xcode if this persists."
    )
    XCTAssertNil(response.data?.x)
    XCTAssertNil(response.data?.y)
    XCTAssertNil(response.data?.x2)
    XCTAssertNil(response.data?.y2)
  }

  func testSelectorTapFallsBackToXCTestCoordinateWhenPrivateSynthesisFails() throws {
    let selector = NSSelectorFromString("synthesizeTapWithApplication:resolvedWindow:x:y:")
    guard
      let synthesizedTapMethod = class_getClassMethod(RunnerSynthesizedGesture.self, selector),
      let failureStubMethod = class_getClassMethod(RunnerSynthesizedTapFailureStub.self, selector)
    else {
      XCTFail("unable to install synthesized tap failure stub")
      return
    }
    let originalImplementation = method_getImplementation(synthesizedTapMethod)
    method_setImplementation(
      synthesizedTapMethod,
      method_getImplementation(failureStubMethod)
    )
    app.launch()
    currentApp = app
    runnerAccessibilityHealth = .healthy
    defer {
      method_setImplementation(synthesizedTapMethod, originalImplementation)
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let command = try runnerCommandFixture(
      #"{"command":"tap","commandId":"selector-tap-fallback","selectorKey":"label","selectorValue":"Agent Device Runner","synthesized":true}"#
    )

    let response = try executeOnMainPrepared(command: command, activeApp: app)

    XCTAssertTrue(response.ok)
    XCTAssertEqual(response.data?.message, "tapped")
    XCTAssertEqual(response.data?.gestureFallback, "xctest-coordinate-tap")
    XCTAssertEqual(response.data?.gestureFallbackMessage, "forced private synthesis failure")
    XCTAssertEqual(
      response.data?.gestureFallbackHint,
      "Falling back to XCTest coordinate tap may be slower and can still need a healthy accessibility tree."
    )
  }
#endif

#if os(iOS)
  // `waitForTextEntryReadiness`'s hardware-keyboard fallback returns early only on confirmed
  // focus (#1874), and `keyboardFocusConfirmed` reads that from the app-wide focus predicate this
  // bundle otherwise refuses to trust. Two XCTest facts it rests on, neither a repository
  // invariant: the predicate reports a responder that shows NO software keyboard at all, and it
  // names the element well enough to tell the tapped field from another one. The fixture field is
  // the exact shape the fallback exists for — a real responder with an empty `inputView` — so this
  // is where both are observable. If either regressed, readiness would silently stop taking the
  // fallback and spend the full readinessTimeout on every hardware-keyboard field, which no other
  // assertion would notice.
  func testHardwareKeyboardResponderConfirmsItsOwnKeyboardFocus() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))

    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForExistence(timeout: appExistenceTimeout))
    let otherElement = app.staticTexts["Agent Device Runner"]
    XCTAssertTrue(otherElement.waitForExistence(timeout: appExistenceTimeout))
    XCTAssertFalse(
      keyboardFocusConfirmed(app: app, element: textField),
      "an untapped field must not confirm focus, or the fallback would fire immediately"
    )

    let tapCommand = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-focus-confirmation","selectorKey":"id","selectorValue":"agent-device-hardware-keyboard-input"}"#
    )
    let tapResponse = try executeOnMainPrepared(command: tapCommand, activeApp: app)
    XCTAssertTrue(tapResponse.ok, String(describing: tapResponse.error))
    try XCTSkipIf(
      isKeyboardVisible(app: app),
      "software keyboard is up: this simulator cannot exercise the hidden-keyboard responder path"
    )

    let deadline = Date().addingTimeInterval(TextEntryTiming.readinessTimeout)
    var confirmed = keyboardFocusConfirmed(app: app, element: textField)
    while !confirmed && Date() < deadline {
      sleepFor(TextEntryTiming.pollInterval)
      confirmed = keyboardFocusConfirmed(app: app, element: textField)
    }
    XCTAssertTrue(confirmed, "a tapped responder must confirm its own keyboard focus")
    XCTAssertFalse(
      keyboardFocusConfirmed(app: app, element: otherElement),
      "focus held by another element must read as a refusal, never as this element's focus"
    )
  }
#endif

  func testInjectedTapRecordedFailureGateIsTapOnlyAndCountGated() {
    // The seam's recording side cannot run in-bundle (a real XCTIssue would
    // fail this very test run — same constraint the record(_:) suppression
    // tests document); the live daemon proof covers it. This pins the gate.
    XCTAssertFalse(RunnerTests.shouldInjectTapRecordedFailure(command: .tap, remaining: 0))
    XCTAssertTrue(RunnerTests.shouldInjectTapRecordedFailure(command: .tap, remaining: 1))
    XCTAssertFalse(RunnerTests.shouldInjectTapRecordedFailure(command: .type, remaining: 1))
    XCTAssertFalse(RunnerTests.shouldInjectTapRecordedFailure(command: .snapshot, remaining: 1))
  }

  func testXCTestRecordedFailureResponseFailsMutatingSuccesses() throws {
    let command = try runnerCommandFixture(#"{"command":"tap","commandId":"tap-1"}"#)
    let response = Response(ok: true, data: DataPayload(message: "tapped"))

    let failureResponse = xctestRecordedFailureResponse(command: command, response: response)

    XCTAssertEqual(failureResponse?.ok, false)
    XCTAssertEqual(failureResponse?.error?.code, "XCTEST_RECORDED_FAILURE")
    XCTAssertEqual(
      failureResponse?.error?.message,
      "XCTest recorded a failure while executing tap; the action may not have been performed."
    )
  }

  func testXCTestRecordedFailureResponseFailsActionButtonSuccess() throws {
    // The Action Button press carries no settle and no post-action observation, so this conversion is
    // the only evidence the press landed. That is why the press is not classified runner-lifecycle:
    // `isLifecycle` would silence the conversion here (#2699, #2702 review).
    let command = try runnerCommandFixture(#"{"command":"actionButton","commandId":"action-button-1"}"#)
    let response = Response(ok: true, data: DataPayload(message: "actionButton"))

    let failureResponse = xctestRecordedFailureResponse(command: command, response: response)

    XCTAssertEqual(failureResponse?.ok, false)
    XCTAssertEqual(failureResponse?.error?.code, "XCTEST_RECORDED_FAILURE")
    XCTAssertEqual(
      failureResponse?.error?.message,
      "XCTest recorded a failure while executing actionButton; the action may not have been performed."
    )
  }

  func testXCTestRecordedFailureResponseDoesNotWrapReadOnlyOrRunnerFatalResponses() throws {
    let snapshotCommand = try runnerCommandFixture(#"{"command":"snapshot","commandId":"snapshot-1"}"#)
    let tapCommand = try runnerCommandFixture(#"{"command":"tap","commandId":"tap-1"}"#)
    let runnerFatalResponse = Response(
      ok: true,
      data: DataPayload(runnerFatal: true, runnerFatalReason: "ax_snapshot_unavailable")
    )

    XCTAssertNil(
      xctestRecordedFailureResponse(
        command: snapshotCommand,
        response: Response(ok: true, data: DataPayload(nodes: [], truncated: false))
      )
    )
    XCTAssertNil(xctestRecordedFailureResponse(command: tapCommand, response: runnerFatalResponse))
  }

  // Simulator-only from here to the matching #endif: these launch the host app, route through
  // SpringBoard, or assert the iOS-only alert/system-modal branches. Tests outside the
  // `os(iOS)` regions in this file are pure runner decisions and also run on the macOS host
  // lane (ci.yml) — see the classification convention in RunnerTests.swift.
#if os(iOS)
  func testMissingBundleCommandInvalidatesCompleteCachedTargetState() throws {
    app.launch()
    currentApp = app
    currentBundleId = "com.example.stale-target"
    currentAppProcessIdentifier = 42
    snapshotXCTestPenaltyWarmupExemptionPending = true
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let command = try runnerCommandFixture(
      #"{"command":"snapshot","commandId":"snapshot-without-bundle"}"#
    )

    _ = prepareActiveCommandContext(command: command)

    XCTAssertNil(currentApp)
    XCTAssertNil(currentBundleId)
    XCTAssertNil(currentAppProcessIdentifier)
    XCTAssertFalse(snapshotXCTestPenaltyWarmupExemptionPending)
  }

  func testSkipAppActivationPreflightIncludesForegroundCachedCoordinateOnlyTaps() throws {
    app.launch()
    currentApp = app
    currentBundleId = nil
    defer {
      currentApp = nil
      currentBundleId = nil
      app.terminate()
    }
    let tap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-1","x":10,"y":20}"#
    )

    XCTAssertTrue(shouldSkipAppActivationPreflight(tap))
  }

  func testSkipAppActivationPreflightRejectsMissingChangedAndBackgroundTargets() throws {
    let coordinateTap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-1","x":10,"y":20}"#
    )
    currentApp = nil
    currentBundleId = nil
    XCTAssertFalse(shouldSkipAppActivationPreflight(coordinateTap))

    app.launch()
    currentApp = app
    currentBundleId = "com.example.current"
    defer {
      currentApp = nil
      currentBundleId = nil
      app.terminate()
    }
    let changedBundleTap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-2","appBundleId":"com.example.other","x":10,"y":20}"#
    )

    XCTAssertFalse(shouldSkipAppActivationPreflight(changedBundleTap))

    app.terminate()
    currentApp = app
    currentBundleId = nil

    XCTAssertFalse(shouldSkipAppActivationPreflight(coordinateTap))
  }

  func testActionButtonPressSkipsAppActivationPreflightWithoutBeingRunnerLifecycle() throws {
    currentApp = nil
    currentBundleId = nil
    let press = try runnerCommandFixture(#"{"command":"actionButton","commandId":"action-button-1"}"#)

    // The skip is its own decision, reached without the lifecycle flag that would also drop the
    // recorded-failure conversion; no cached target and no foreground app is required for it.
    XCTAssertFalse(isRunnerLifecycleCommand(.actionButton))
    XCTAssertTrue(shouldSkipAppActivationPreflight(press))
  }

  func testPrepareActiveCommandContextRoutesBlockingSystemModalToSpringboard() throws {
    blockingSystemModalPresenceOverrideForTesting = true
    currentApp = nil
    currentBundleId = nil
    defer {
      blockingSystemModalPresenceOverrideForTesting = nil
      currentApp = nil
      currentBundleId = nil
    }
    let tap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-1","x":10,"y":20}"#
    )

    let preparation = prepareActiveCommandContext(
      command: tap,
      routeToSpringboard: shouldRouteToSpringboardBlockingSystemModal(tap)
    )

    guard case .context(let context) = preparation else {
      XCTFail("expected command context")
      return
    }
    XCTAssertTrue(context.app === springboard)
  }

  func testExecuteDispatchedReturnsBusyBeforeBlockingSystemModalProbeDrains() throws {
    app.launch()
    currentApp = app
    currentBundleId = nil
    defer {
      currentApp = nil
      currentBundleId = nil
      systemModalProbeOverrideForTesting = nil
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      app.terminate()
    }

    final class ResultBox {
      var response: Response?
      var error: Error?
      var commandRecoveredBeforeRelease = false
      var wasBusyBeforeRelease = false
      var hadAbandonedProbeBeforeRelease = false
      var drained = false
    }
    let box = ResultBox()
    let probeStarted = expectation(description: "system-modal routing probe started")
    let verificationFinished = expectation(description: "command recovery and modal probe drain verified")
    let probeReleaseGate = DispatchSemaphore(value: 0)
    let commandFinishedGate = DispatchSemaphore(value: 0)
    systemModalProbeOverrideForTesting = { _ in
      probeStarted.fulfill()
      _ = probeReleaseGate.wait(timeout: .now() + 15)
      return DataPayload(message: "late system modal")
    }

    let command = try runnerCommandFixture(
      #"{"command":"tap","commandId":"bounded-modal-routing","x":10,"y":20}"#
    )
    DispatchQueue(label: "agent-device.runner.tests.modal-routing-probe").async {
      do {
        box.response = try self.executeDispatched(command: command)
      } catch {
        box.error = error
      }
      commandFinishedGate.signal()
    }
    DispatchQueue(label: "agent-device.runner.tests.modal-routing-probe-verifier").async {
      let commandWait = commandFinishedGate.wait(
        timeout: .now() + self.systemModalProbeBudget + 3
      )
      box.commandRecoveredBeforeRelease = commandWait == .success
        && box.error == nil
        && box.response?.error?.code == "RUNNER_BUSY"
      if case .busy = self.currentMainThreadBusyState() {
        box.wasBusyBeforeRelease = true
      }
      box.hadAbandonedProbeBeforeRelease = self.hasAbandonedMainThreadWork()

      // The XCTest main thread is blocked inside the injected probe, so this verifier owns the
      // ordered release after recording the command result and abandoned-work state above.
      probeReleaseGate.signal()
      let deadline = Date().addingTimeInterval(5)
      while self.hasAbandonedMainThreadWork(), Date() < deadline {
        self.sleepFor(0.002)
      }
      box.drained = !self.hasAbandonedMainThreadWork()
      verificationFinished.fulfill()
    }

    wait(for: [probeStarted, verificationFinished], timeout: 15)
    XCTAssertTrue(
      box.commandRecoveredBeforeRelease,
      "the public coordinate tap must return RUNNER_BUSY before the blocked modal probe drains"
    )
    XCTAssertTrue(box.wasBusyBeforeRelease)
    XCTAssertTrue(box.hadAbandonedProbeBeforeRelease)
    XCTAssertTrue(box.drained)
    guard case .idle = currentMainThreadBusyState() else {
      return XCTFail("expected the runner to become idle after the routing probe drained")
    }
    XCTAssertFalse(hasAbandonedMainThreadWork())
  }

  func testSkipAppActivationPreflightRejectsSelectorAndMixedSequenceGestures() throws {
    app.launch()
    currentApp = app
    currentBundleId = nil
    defer {
      currentApp = nil
      currentBundleId = nil
      app.terminate()
    }
    let selectorTap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-1","selectorKey":"label","selectorValue":"Search","synthesized":true}"#
    )
    let standardDrag = try runnerCommandFixture(
      #"{"command":"drag","commandId":"drag-1","x":10,"y":20,"x2":30,"y2":40}"#
    )
    let mixedSequence = try runnerCommandFixture(
      """
      {"command":"sequence","commandId":"seq-1","steps":[
        {"kind":"tap","x":10,"y":20,"synthesized":true},
        {"kind":"doubleTap","x":30,"y":40}
      ]}
      """
    )

    XCTAssertFalse(shouldSkipAppActivationPreflight(selectorTap))
    XCTAssertFalse(shouldSkipAppActivationPreflight(standardDrag))
    XCTAssertFalse(shouldSkipAppActivationPreflight(mixedSequence))
  }

  // Launches nothing, but still simulator-only: `shouldSkipAppActivationPreflight` is
  // `#if os(iOS) …guards… #else return false #endif`, so on macOS this asserts a compile-time
  // literal and no edit to the iOS body could make it red. Its five siblings above and below
  // are gated for the same reason.
  func testSkipAppActivationPreflightRequiresCachedForegroundTarget() throws {
    currentApp = nil
    currentBundleId = nil
    let scroll = try runnerCommandFixture(
      #"{"command":"scroll","commandId":"scroll-1","direction":"down","pixels":400}"#
    )

    XCTAssertFalse(shouldSkipAppActivationPreflight(scroll))
  }

  func testSkipAppActivationPreflightKeepsDragScrollAndSequenceOnForegroundGuard() throws {
    app.launch()
    currentApp = app
    currentBundleId = nil
    defer {
      currentApp = nil
      currentBundleId = nil
      app.terminate()
    }
    let drag = try runnerCommandFixture(
      #"{"command":"drag","commandId":"drag-1","x":10,"y":20,"x2":30,"y2":40}"#
    )
    let scroll = try runnerCommandFixture(
      #"{"command":"scroll","commandId":"scroll-1","direction":"down","pixels":400}"#
    )
    let sequence = try runnerCommandFixture(
      """
      {"command":"sequence","commandId":"seq-1","steps":[
        {"kind":"tap","x":10,"y":20,"synthesized":true},
        {"kind":"longPress","x":10,"y":200,"durationMs":300}
      ]}
      """
    )

    XCTAssertFalse(shouldSkipAppActivationPreflight(drag))
    XCTAssertFalse(shouldSkipAppActivationPreflight(scroll))
    XCTAssertFalse(shouldSkipAppActivationPreflight(sequence))
  }

  func testSkipAppActivationPreflightIncludesAlertCommands() throws {
    let alert = try runnerCommandFixture(
      #"{"command":"alert","commandId":"alert-1","action":"get"}"#
    )

    XCTAssertTrue(shouldSkipAppActivationPreflight(alert))
  }
#endif

  func testDispatchReturnsBusyBeforeQueueingMainThreadWork() throws {
    let command = try runnerCommandFixture(#"{"command":"snapshot","commandId":"snapshot-busy"}"#)
    abandonedMainThreadWorkCount = 1
    abandonedMainThreadWorkSince = Date(timeIntervalSinceNow: -2)
    defer {
      abandonedMainThreadWorkCount = 0
      abandonedMainThreadWorkSince = nil
    }

    let response = try execute(command: command)

    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "RUNNER_BUSY")
    XCTAssertTrue(response.error?.message.contains("previous command") == true)
  }

  func testDispatchReturnsWedgedBeforeQueueingMainThreadWork() throws {
    let command = try runnerCommandFixture(#"{"command":"snapshot","commandId":"snapshot-wedged"}"#)
    abandonedMainThreadWorkCount = 1
    abandonedMainThreadWorkSince = Date(timeIntervalSinceNow: -(mainThreadWedgeThreshold + 1))
    defer {
      abandonedMainThreadWorkCount = 0
      abandonedMainThreadWorkSince = nil
    }

    let response = try execute(command: command)

    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "RUNNER_WEDGED")
    XCTAssertTrue(response.error?.hint?.contains("runner session will be restarted") == true)
  }

  func testPostSnapshotDelayMarkDoesNotQueueBehindAbandonedMainThreadWork() {
    abandonedMainThreadWorkCount = 1
    defer {
      abandonedMainThreadWorkCount = 0
      needsPostSnapshotInteractionDelay = false
    }

    let finished = expectation(description: "off-main caller finished")
    DispatchQueue(label: "agent-device.runner.tests.post-snapshot-delay").async {
      self.setNeedsPostSnapshotInteractionDelay()
      finished.fulfill()
    }

    wait(for: [finished], timeout: 1)
    mainThreadWorkLock.lock()
    let abandonedWorkCount = abandonedMainThreadWorkCount
    mainThreadWorkLock.unlock()
    XCTAssertEqual(abandonedWorkCount, 1, "the skipped mark must not add an abandoned unit")
    XCTAssertFalse(needsPostSnapshotInteractionDelay)
  }

  func testSnapshotFailureInvalidationQueuesBehindAbandonedMainThreadWorkWithoutWaiting() {
    currentBundleId = "com.example.stale-target"
    defer { currentBundleId = nil }

    final class ResultBox {
      var elapsed: TimeInterval?
      var bundleStillCachedWhileBlocked: Bool?
      var abandonedWhileBlocked: Int?
    }
    let box = ResultBox()
    let mainBlocked = DispatchSemaphore(value: 0)
    let releaseMain = DispatchSemaphore(value: 0)
    let finished = expectation(description: "invalidation returned while main was blocked")

    DispatchQueue(label: "agent-device.runner.tests.snapshot-invalidation").async {
      _ = try? self.runMainThreadWork(
        "command_execution",
        timeout: 0,
        timeoutError: self.mainThreadExecutionTimeoutError
      ) {
        mainBlocked.signal()
        _ = releaseMain.wait(timeout: .now() + 5)
        return true
      }
      _ = mainBlocked.wait(timeout: .now() + 2)
      let startedAt = Date()
      self.invalidateCachedTargetAfterSnapshotFailure()
      box.elapsed = Date().timeIntervalSince(startedAt)
      box.bundleStillCachedWhileBlocked = self.currentBundleId != nil
      self.mainThreadWorkLock.lock()
      box.abandonedWhileBlocked = self.abandonedMainThreadWorkCount
      self.mainThreadWorkLock.unlock()
      releaseMain.signal()
      finished.fulfill()
    }

    wait(for: [finished], timeout: 8)
    let drainDeadline = Date().addingTimeInterval(2)
    while hasAbandonedMainThreadWork() || currentBundleId != nil, Date() < drainDeadline {
      sleepFor(0.005)
    }

    XCTAssertLessThan(
      box.elapsed ?? .infinity,
      0.5,
      "the failed capture must not wait behind abandoned main-thread work"
    )
    XCTAssertEqual(
      box.bundleStillCachedWhileBlocked,
      true,
      "the drop must queue behind the blocked main thread, not run early"
    )
    XCTAssertEqual(box.abandonedWhileBlocked, 1, "the deferred drop must not add an abandoned unit")
    XCTAssertFalse(hasAbandonedMainThreadWork())
    XCTAssertNil(currentBundleId, "the drop must run once the main thread frees")
  }

  /// Routes `command` through the transport's inline and queued paths. The calling test's main
  /// thread serves the command's main-thread work while it waits.
  func execute(command: Command) throws -> Response {
    dispatchPrecondition(condition: .onQueue(.main))
    if let response = inlineResponse(for: command) {
      return response
    }
    final class ResultBox {
      var result: Result<Response, Error>?
    }
    let box = ResultBox()
    let executed = XCTestExpectation(description: "\(command.command.rawValue) executed off main")
    enqueueAccepted(command: command) { result in
      box.result = result
      executed.fulfill()
    }
    guard XCTWaiter.wait(for: [executed], timeout: mainThreadExecutionTimeout + 5) == .completed,
      let result = box.result
    else {
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.commandReturnedNoResponse,
        userInfo: [NSLocalizedDescriptionKey: "command did not finish on the command queue"]
      )
    }
    return try result.get()
  }

  func runnerCommandFixture(_ json: String) throws -> Command {
    try JSONDecoder().decode(Command.self, from: Data(json.utf8))
  }
}
#endif
