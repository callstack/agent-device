import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  func testPenalizedCoordinateTapPreservesBareTypeWitnessWhenSoftwareKeyboardIsHidden() throws {
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
    let frame = textField.frame
    XCTAssertFalse(frame.isEmpty)
    currentApp = app
    currentBundleId = "com.callstack.agentdevice.runner"
    currentAppProcessIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))
    penalizeSnapshotXCTestChannel(bundleId: nil, reason: "test")

    let tapCommand = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-penalized-coordinate-input","x":\#(frame.midX),"y":\#(frame.midY),"synthesized":true}"#
    )
    let tapResponse = try executeOnMainPrepared(command: tapCommand, activeApp: app)
    XCTAssertTrue(tapResponse.ok, String(describing: tapResponse.error))
    XCTAssertFalse(
      isKeyboardVisible(app: app),
      "the test must exercise a focused responder with the software keyboard hidden"
    )

    let failureCountBefore = currentXCTestFailureCount()
    let typeCommand = try runnerCommandFixture(
      #"{"command":"type","commandId":"type-after-penalized-coordinate","text":"coordinate-witness"}"#
    )
    let typeResponse = executeTypeCommand(activeApp: app, command: typeCommand)

    XCTAssertTrue(typeResponse.ok, String(describing: typeResponse.error))
    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertEqual(typeResponse.data?.textEntryRoute, "synthesized-first-responder")
    XCTAssertEqual(String(describing: textField.value ?? ""), "coordinate-witness")

    let secondFailureCountBefore = currentXCTestFailureCount()
    let secondTypeCommand = try runnerCommandFixture(
      #"{"command":"type","commandId":"type-after-consumed-coordinate-witness","text":"-again"}"#
    )
    let secondTypeResponse = executeTypeCommand(activeApp: app, command: secondTypeCommand)

    XCTAssertFalse(secondTypeResponse.ok)
    XCTAssertEqual(secondTypeResponse.error?.code, "TEXT_INPUT_NOT_FOCUSED")
    XCTAssertFalse(didRecordXCTestFailure(since: secondFailureCountBefore))
    XCTAssertEqual(String(describing: textField.value ?? ""), "coordinate-witness")
  }
#endif
}
