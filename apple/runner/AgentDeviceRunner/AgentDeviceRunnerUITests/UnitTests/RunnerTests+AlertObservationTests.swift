import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  func testAlertAcceptDoesNotActivateAReplacementWithASharedButton() throws {
    try assertReplacementAlertUntouched(action: "accept", arguments: [], confirmed: true)
  }

  func testAlertDismissDoesNotActivateAReplacementWithTheSameTitle() throws {
    try assertReplacementAlertUntouched(action: "dismiss", arguments: ["--agent-device-alert-same-title"], confirmed: true)
  }

  func testAlertCannotProveAnIdenticalReplacementAndDoesNotActivateIt() throws {
    try assertReplacementAlertUntouched(
      action: "accept",
      arguments: ["--agent-device-alert-same-title", "--agent-device-alert-same-body"],
      confirmed: false
    )
  }

  func testAlertDeadlineBeforeActivationLeavesTheOriginalUntouched() throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let alert = try XCTUnwrap(resolveAlert(app: app, deadline: Date().addingTimeInterval(10)))
    let response = handleAlert(alert, action: "accept", deadline: .distantPast)
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "ALERT_DEADLINE_EXCEEDED")
    XCTAssertTrue(app.alerts.firstMatch.exists)
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 0; replacement actions: 0")
  }

  private func assertReplacementAlertUntouched(action: String, arguments: [String], confirmed: Bool) throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression"] + arguments
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let command = try runnerCommandFixture(
      #"{"command":"alert","commandId":"alert-replacement","action":"\#(action)","timeoutMs":10000}"#
    )
    let response = try executeOnMainPrepared(command: command, activeApp: app)
    XCTAssertEqual(response.ok, confirmed, String(describing: response.error))
    if !confirmed { XCTAssertEqual(response.error?.code, "ALERT_DEADLINE_EXCEEDED") }
    XCTAssertTrue(app.alerts.firstMatch.exists, "the replacement must remain visible")
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 1; replacement actions: 0")
    let current = try XCTUnwrap(resolveAlert(app: app, deadline: Date().addingTimeInterval(10)))
    let inspection = handleAlert(current, action: "get", deadline: Date().addingTimeInterval(10))
    XCTAssertTrue(inspection.ok)
    XCTAssertEqual(inspection.data?.items?.sorted(), ["Cancel", "OK"])
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 1; replacement actions: 0")
  }
#endif
}
