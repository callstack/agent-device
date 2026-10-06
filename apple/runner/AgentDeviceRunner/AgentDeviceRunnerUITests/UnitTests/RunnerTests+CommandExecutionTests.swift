import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

private final class RunnerSynthesizedTapFailureStub: NSObject {
  @objc(synthesizeTapWithApplication:resolvedWindow:x:y:deadline:errorMessage:)
  class func synthesizeTap(
    application: XCUIApplication,
    resolvedWindow: Any?,
    x: Double,
    y: Double,
    deadline: NSDate?,
    errorMessage: AutoreleasingUnsafeMutablePointer<NSString?>?
  ) -> RunnerTapSynthesisStatus {
    errorMessage?.pointee = "forced private synthesis failure"
    return .failed
  }
}

extension RunnerTests {
  /// Makes private tap synthesis fail until the returned closure restores it.
  func forceSynthesizedTapFailure() throws -> () -> Void {
    let selector = NSSelectorFromString("synthesizeTapWithApplication:resolvedWindow:x:y:deadline:errorMessage:")
    let synthesizedTapMethod = try XCTUnwrap(class_getClassMethod(RunnerSynthesizedGesture.self, selector))
    let failureStubMethod = try XCTUnwrap(class_getClassMethod(RunnerSynthesizedTapFailureStub.self, selector))
    let originalImplementation = method_getImplementation(synthesizedTapMethod)
    method_setImplementation(synthesizedTapMethod, method_getImplementation(failureStubMethod))
    return { method_setImplementation(synthesizedTapMethod, originalImplementation) }
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
#if os(iOS)
  @MainActor
  func testSelectorTapFallsBackToXCTestCoordinateWhenPrivateSynthesisFails() throws {
    let restoreSynthesizedTap = try forceSynthesizedTapFailure()
    app.launch()
    mainOwned.app = app
    mainOwned.accessibilityHealth = .healthy
    defer {
      restoreSynthesizedTap()
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
  @MainActor
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

  // #3060: a Flutter password field reports `TextField` through the legacy accessibility attributes and
  // `Other` through the modern ones once it takes focus, so it stops answering the type-bound query that
  // resolved it. The runner classified its resolved element AFTER dispatching, which re-ran that query,
  // and XCTest answered `No matches found for Element at index 1 from input {(TextField)}` — a recorded
  // failure that failed the command and restarted the runner for a tap the dispatch had already landed.
  // The fixture reaches the same consequence by leaving the tree on focus, and its app-side delegate
  // witness lets the test prove the gesture took focus when the accessibility tree no longer can.

  /// The route the issue measured: `click @ref` and `press <x> <y>` both reach a coordinate tap, whose
  /// probe handle is bound to the index it held in the type-bound query — the shape of the log's
  /// `Element at index 1 from input {(TextField)}`. A tap that lands must report `tapped` and leave no
  /// recorded failure for the dispatch path to convert into `XCTEST_RECORDED_FAILURE` and a runner
  /// restart, while still booking the witness that the next bare `type` is addressed by.
  ///
  /// The witness assertion pins how it is booked, not that a following `type` uses it: this fixture's
  /// field is gone from the tree by then, so the next `type` would refuse the handle. What the tap must
  /// not need is a read of the handle to decide whether to book it.
  @MainActor
  func testCoordinateTapOnInputThatLeavesTheTreeOnFocusReportsTapped() throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-unqueryable-on-focus",
    ]
    app.launch()
    defer {
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForExistence(timeout: appExistenceTimeout))
    let frame = field.frame
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    mainOwned.processIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))
    clearSnapshotXCTestChannelPenalty(reason: "fresh-runner")

    let failures = currentXCTestFailureCount()
    let tap = try runnerCommandFixture(
      #"{"appBundleId":"com.callstack.agentdevice.runner","command":"tap","commandId":"tap-unqueryable-on-focus","x":\#(frame.midX),"y":\#(frame.midY),"synthesized":true}"#
    )
    let response = try execute(command: tap)

    XCTAssertEqual(response.data?.message, "tapped", String(describing: response.error))
    XCTAssertFalse(didRecordXCTestFailure(since: failures))
    // The app's own delegate callbacks, not the accessibility tree: without this, "nothing recorded a
    // failure" would also be satisfied by a gesture that never reached the field at all.
    XCTAssertEqual(
      app.staticTexts["agent-device-text-entry-focus"].label,
      "focus",
      "the tap must have taken focus from the field it resolved"
    )
    XCTAssertNotNil(
      textEntryTapWitness,
      "the tap still authorizes the next bare type from what it knew before dispatching"
    )
  }

  /// The same invariant on the selector route, which read the element three times after its gesture: the
  /// type again inside `rememberTextEntryTap`, then the type and the frame in the readiness wait. On this
  /// fixture the route's identifier-bound handle stops resolving once the field hides, so each of those
  /// recorded a failure the command inherits. `click @ref` and `press <x> <y>` in the report both reached
  /// the coordinate route above, so this holds the second route to the same rule rather than reproducing
  /// the reported lookup.
  @MainActor
  func testSelectorTapOnInputThatLeavesTheTreeOnFocusRecordsNoFailure() throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-unqueryable-on-focus",
    ]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))
    XCTAssertTrue(
      app.textFields["agent-device-hardware-keyboard-input"].waitForExistence(timeout: appExistenceTimeout)
    )
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    mainOwned.processIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))

    let failures = currentXCTestFailureCount()
    let tap = try runnerCommandFixture(
      #"{"appBundleId":"com.callstack.agentdevice.runner","command":"tap","commandId":"selector-tap-unqueryable-on-focus","selectorKey":"id","selectorValue":"agent-device-hardware-keyboard-input","synthesized":true}"#
    )
    let response = try execute(command: tap)

    XCTAssertEqual(response.data?.message, "tapped", String(describing: response.error))
    XCTAssertFalse(didRecordXCTestFailure(since: failures))
    XCTAssertEqual(
      app.staticTexts["agent-device-text-entry-focus"].label,
      "focus",
      "the tap must have taken focus from the field it resolved"
    )
    XCTAssertNotNil(textEntryTapWitness)
  }
#endif
}
#endif
