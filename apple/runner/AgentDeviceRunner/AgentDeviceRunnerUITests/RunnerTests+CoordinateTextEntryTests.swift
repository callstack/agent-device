import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
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
    currentApp = app
    currentBundleId = "com.callstack.agentdevice.runner"
    currentAppProcessIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))

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
      #"{"command":"type","commandId":"type-after-penalized-non-text-target","text":"must-not-type"}"#
    )
    let typeResponse = executeTypeCommand(activeApp: app, command: typeCommand)

    XCTAssertFalse(typeResponse.ok)
    XCTAssertEqual(typeResponse.error?.code, "TEXT_INPUT_NOT_FOCUSED")
    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertEqual(String(describing: textField.value ?? ""), "")
  }
#endif
}
