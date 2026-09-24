import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

private final class RunnerSynthesizedTapFailureStub: NSObject {
  @objc(synthesizeTapWithApplication:resolvedWindow:x:y:)
  class func synthesizeTap(application: XCUIApplication, resolvedWindow: Any?, x: Double, y: Double) -> String? {
    "forced private synthesis failure"
  }
}

extension RunnerTests {
  /// Makes private tap synthesis fail until the returned closure restores it.
  func forceSynthesizedTapFailure() throws -> () -> Void {
    let selector = NSSelectorFromString("synthesizeTapWithApplication:resolvedWindow:x:y:")
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
#endif
}
#endif
