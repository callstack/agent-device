import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  @MainActor
  func testConfirmedInputReadinessReturnsBeforeItsReadinessWindow() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForExistence(timeout: appExistenceTimeout))
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

#endif
}
