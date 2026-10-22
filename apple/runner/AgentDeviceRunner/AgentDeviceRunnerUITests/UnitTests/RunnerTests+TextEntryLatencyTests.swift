import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  @MainActor
  func testConfirmedInputReadinessReturnsBeforeItsReadinessWindow() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    field.tap()
    XCTAssertTrue(keyboardFocusConfirmed(app: app, element: field))
    let failures = currentXCTestFailureCount()
    let startedAt = Date()
    waitForTextEntryReadinessAfterTap(app: app, element: field)
    let elapsed = Date().timeIntervalSince(startedAt)
    XCTAssertFalse(didRecordXCTestFailure(since: failures))
    XCTAssertTrue(keyboardFocusConfirmed(app: app, element: field))
    XCTAssertLessThan(elapsed, TextEntryTiming.readinessTimeout)
  }

  /// After a focus tap raises the software keyboard, stabilization takes focus from the tapped
  /// input's own read before it asks for the keyboard. While the keyboard is presented, the keyboard
  /// query blocks and then finds none: after a fill's focus tap it took 0.68 s on the test app
  /// (iPhone 17 Pro, iOS 27.0) and 0.57–3.77 s on CI. The keyboard is already up here, so asking it
  /// first confirms focus from the keyboard's arrival instead.
  @MainActor
  func testFocusStabilizationAsksTheTappedInputBeforeTheKeyboard() throws {
    app.launchArguments = ["--agent-device-text-entry-regression", "--agent-device-text-entry-soft-keyboard"]
    app.launch()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    field.tap()
    try XCTSkipUnless(
      app.keyboards.firstMatch.waitForFixtureExistence(timeout: appExistenceTimeout),
      "software keyboard is down: this simulator cannot show the keyboard a focus tap raises"
    )

    let stabilized = stabilizeTextInputBeforeTyping(app: app, target: field, keyboardVisibleBeforeTap: false)

    XCTAssertEqual(stabilized.evidence, .inputReportsKeyboardFocus)
    XCTAssertEqual(stabilized.inputFrame, field.frame)
  }

  /// A fill whose focus tap raises the software keyboard types and reads its text back when focus is
  /// confirmed from the input rather than from the keyboard's arrival.
  @MainActor
  func testFillThatRaisesTheSoftwareKeyboardTypesAndReadsBack() throws {
    app.launchArguments = ["--agent-device-text-entry-regression", "--agent-device-text-entry-soft-keyboard"]
    app.launch()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    XCTAssertFalse(isKeyboardVisible(app: app))
    let frame = field.frame
    let fill = try runnerCommandFixture(
      #"{"command":"type","commandId":"fill-raises-keyboard","text":"hello","textEntryMode":"replace","x":\#(frame.midX),"y":\#(frame.midY)}"#
    )

    let response = executeTypeCommand(activeApp: app, command: fill)

    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(response.data?.textEntryRoute, "xctest-element")
    XCTAssertEqual(field.value as? String, "hello")
    try XCTSkipUnless(
      app.keyboards.firstMatch.waitForFixtureExistence(timeout: appExistenceTimeout),
      "software keyboard is down: this simulator did not raise the keyboard the focus tap asked for"
    )
  }
#endif
}
