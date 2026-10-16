import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  /// The input the coordinate probe finds at the point, failing the test when it finds none or
  /// cannot answer. A fixture that does not expose its own field is a broken lane, not a refusal.
  @MainActor
  func requireTextInputAtPoint(app: XCUIApplication, x: Double, y: Double) throws -> TextInputAtPoint {
    switch coordinateTapTextInputIdentityAt(app: app, x: x, y: y) {
    case .input(let input):
      return input
    case .absent:
      return try XCTUnwrap(
        nil as TextInputAtPoint?,
        "the probe found no input at the fixture's own field"
      )
    case .unavailable:
      return try XCTUnwrap(
        nil as TextInputAtPoint?,
        "the probe could not read the fixture's own field"
      )
    }
  }

  @MainActor
  func testPenalizedCoordinateTapOnNonTextControlDoesNotAuthorizeBareType() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    defer {
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))

    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForExistence(timeout: appExistenceTimeout))
    let nonTextTarget = app.staticTexts["Agent Device Runner"]
    XCTAssertTrue(nonTextTarget.waitForExistence(timeout: appExistenceTimeout))
    let nonTextFrame = nonTextTarget.frame
    XCTAssertFalse(nonTextFrame.isEmpty)
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    mainOwned.processIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))

    let focusCommand = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-stale-responder-input","selectorKey":"id","selectorValue":"agent-device-hardware-keyboard-input"}"#
    )
    let focusResponse = try executeOnMainPrepared(command: focusCommand, activeApp: app)
    XCTAssertTrue(focusResponse.ok, String(describing: focusResponse.error))
    XCTAssertFalse(
      isKeyboardVisible(app: app),
      "the test must leave a responder focused while the software keyboard is hidden"
    )

    penalizeSnapshotXCTestChannel(bundleId: nil, reason: "test")

    let tapCommand = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-penalized-non-text-target","x":\#(nonTextFrame.midX),"y":\#(nonTextFrame.midY),"synthesized":true}"#
    )
    let tapResponse = try executeOnMainPrepared(command: tapCommand, activeApp: app)
    XCTAssertTrue(tapResponse.ok, String(describing: tapResponse.error))

    let failureCountBefore = currentXCTestFailureCount()
    let typeCommand = try runnerCommandFixture(
      #"{"command":"type","commandId":"type-after-penalized-non-text-target","text":"must-not-type","textEntryMode":"append"}"#
    )
    let typeResponse = executeTypeCommand(activeApp: app, command: typeCommand)

    XCTAssertFalse(typeResponse.ok)
    XCTAssertEqual(typeResponse.error?.code, "TEXT_INPUT_NOT_FOCUSED")
    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertEqual(String(describing: textField.value ?? ""), "")
  }

  /// A penalized coordinate `fill` whose point names no text input cannot bind its replacement to a
  /// target, so it refuses with the typed reason instead of clearing and typing through the app-level
  /// first responder — which, while an earlier field still holds focus, destroys that field's text.
  /// The aim point is a button that counts its presses: a refusal that dispatched its focus tap first
  /// would move that counter even though the field came through, so the counter is what proves the
  /// refusal happened before the tap rather than after it.
  @MainActor
  func testPenalizedCoordinateFillAtAPointWithNoTextInputRefusesBeforeItsTapAndKeepsTheFocusedField() throws {
    let field = try focusSynthesizedReplacementField(extraLaunchArguments: [
      "--agent-device-text-entry-tap-witness",
    ])
    defer { tearDownSynthesizedReplacementField() }
    let seeded = try replaceSynthesizedFieldText(field, text: "stale", commandId: "seed-non-text-point")
    XCTAssertTrue(seeded.ok, String(describing: seeded.error))

    let nonTextTarget = app.buttons["agent-device-tap-witness"]
    XCTAssertTrue(nonTextTarget.waitForExistence(timeout: appExistenceTimeout))
    let nonTextFrame = nonTextTarget.frame
    XCTAssertFalse(nonTextFrame.isEmpty)
    let pressCount = app.staticTexts["agent-device-tap-witness-presses"]
    XCTAssertTrue(pressCount.waitForExistence(timeout: appExistenceTimeout))

    let fillCommand = try runnerCommandFixture(
      #"{"command":"type","commandId":"fill-penalized-non-text-point","text":"must-not-replace","textEntryMode":"replace","x":\#(nonTextFrame.midX),"y":\#(nonTextFrame.midY)}"#
    )
    let failureCountBefore = currentXCTestFailureCount()
    let fillResponse = executeTypeCommand(activeApp: app, command: fillCommand)

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertFalse(fillResponse.ok, String(describing: fillResponse.error))
    XCTAssertEqual(fillResponse.error?.code, "NO_TEXT_INPUT_AT_POINT")
    XCTAssertEqual(String(describing: field.value ?? ""), "stale")
    XCTAssertEqual(
      pressCount.label,
      "presses=0",
      "the refusal dispatched its focus tap: the point's control took the press"
    )
  }
#endif
}
