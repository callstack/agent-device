import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  /// A field whose app owns its value re-applies that value a moment after the edit which produced
  /// it, the way a controlled React Native `TextInput` does. A replacement burst typed faster than
  /// the write lands has its in-flight characters erased by the app itself, so the field settles
  /// stable short of the request — the shape CI reported for `fill id="field-email" ada@example`
  /// as `aexample`. The pace bound on synthesized replacement is what this pins: raising it back
  /// re-opens the race and this test goes red. The commit wait cannot stand in for it, because a
  /// retype races the same write instead of repairing it.
  func testSynthesizedReplacementSurvivesFieldValueWrittenBackByTheApp() throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression", "--agent-device-text-entry-async-value-write"
    ]
    app.launch()
    defer {
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))

    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForExistence(timeout: appExistenceTimeout))
    currentApp = app
    currentBundleId = "com.callstack.agentdevice.runner"
    currentAppProcessIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))

    let focusCommand = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-async-write-field","selectorKey":"id","selectorValue":"agent-device-hardware-keyboard-input"}"#
    )
    let focusResponse = try executeOnMainPrepared(command: focusCommand, activeApp: app)
    XCTAssertTrue(focusResponse.ok, String(describing: focusResponse.error))

    penalizeSnapshotXCTestChannel(bundleId: nil, reason: "test")

    let frame = textField.frame
    XCTAssertFalse(frame.isEmpty)

    // Twice: the second replacement selects the first one's value away, which is the shape the
    // reported CI trace had — a `fill` onto a field that already held text.
    for commandId in ["fill-async-write-first", "fill-async-write-second"] {
      let command = try runnerCommandFixture(
        #"{"command":"type","commandId":"\#(commandId)","text":"ada@example","textEntryMode":"replace","x":\#(frame.midX),"y":\#(frame.midY)}"#
      )
      let failuresBeforeType = currentXCTestFailureCount()
      let response = executeTypeCommand(activeApp: app, command: command)
      XCTAssertTrue(response.ok, String(describing: response.error))
      XCTAssertEqual(response.data?.textEntryRoute, "synthesized-first-responder-replacement")
      XCTAssertFalse(didRecordXCTestFailure(since: failuresBeforeType))
      XCTAssertEqual(String(describing: textField.value ?? ""), "ada@example")
    }

    // Without a write-back that actually ran, the value above would only prove the fixture is
    // inert. A block scheduled during the burst can also fire after it, which is why only the
    // per-edit attempts are asserted: whether a write landed in flight is what the value checks
    // above answer, and the label's applied count is there to read when they do not.
    Thread.sleep(forTimeInterval: 0.5)
    let writeBackCounts = app.staticTexts["agent-device-text-entry-write-backs"].label
      .split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
    XCTAssertEqual(writeBackCounts.count, 2, "unexpected write-back status: \(writeBackCounts)")
    XCTAssertGreaterThan(try XCTUnwrap(writeBackCounts.first), 0)
  }
#endif
}
