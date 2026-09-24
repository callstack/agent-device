import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  /// An app that owns its field's value renders it some time after the edit that produced it, the
  /// way a controlled React Native `TextInput` does. A burst typed faster than that render has its
  /// in-flight characters erased by the app's own write, which the app then reads back into its
  /// model, so the field settles stable short of the request — the shape CI reported for
  /// `fill id="field-email" ada@example` as `aexample`.
  ///
  /// The acknowledge window this fixture watches is deliberately far stricter than the
  /// `synthesizedAcknowledgeWindowSeconds` budget the shipped pace is sized for. On a loaded host the
  /// characters of a paced burst do not arrive a full interval apart, so a fixture watching that
  /// budget fails on pacing noise rather than on the mechanism. An app that renders every edit
  /// within 5 ms is one no pace this runner could ship outruns, which is the half that is worth
  /// pinning on every PR; the budget itself is pinned by
  /// `testSynthesizedPaceLeavesRoomForAnAppToAcknowledgeEachEdit`. The same run at that budget with
  /// the pre-fix 60-characters-per-second pace leaves the field holding `a` against 20 write-backs:
  /// harsher than the one lost run CI saw, because an app that never catches up mid-burst loses
  /// every character after the first, and the reason the fixture decides at the edit instead of on a
  /// timer — a scheduled write lands differently every time a host is loaded, which is how this test
  /// failed on CI before the model changed.
  func testSynthesizedReplacementSurvivesFieldValueWrittenBackByTheApp() throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-app-owned-value",
      "--agent-device-text-entry-acknowledge-window", "0.005"
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
      #"{"command":"tap","commandId":"tap-app-owned-field","selectorKey":"id","selectorValue":"agent-device-hardware-keyboard-input"}"#
    )
    let focusResponse = try executeOnMainPrepared(command: focusCommand, activeApp: app)
    XCTAssertTrue(focusResponse.ok, String(describing: focusResponse.error))

    penalizeSnapshotXCTestChannel(bundleId: nil, reason: "test")

    let frame = textField.frame
    XCTAssertFalse(frame.isEmpty)

    // Twice: the second replacement selects the first one's value away, which is the shape the
    // reported CI trace had — a `fill` onto a field that already held text.
    for commandId in ["fill-app-owned-first", "fill-app-owned-second"] {
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

    // Without an edit this app actually rendered, the value above would only prove the fixture is
    // inert. Zero write-backs says the app never had a render in flight to lose the burst against.
    let counts = app.staticTexts["agent-device-text-entry-write-backs"].label
      .split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
    XCTAssertEqual(counts.count, 2, "unexpected write-back status: \(counts)")
    XCTAssertGreaterThan(try XCTUnwrap(counts.first), 0)
    XCTAssertEqual(try XCTUnwrap(counts.last), 0)
  }

  /// A replacement the command budget cannot carry is refused before the first character is posted,
  /// so a `fill` cannot end in a transport timeout that leaves the runner typing into a field nobody
  /// is waiting for and the next command finding it busy.
  func testSynthesizedReplacementRefusesTextBeyondTheDeliveryBudget() throws {
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
    currentApp = app
    currentBundleId = "com.callstack.agentdevice.runner"
    currentAppProcessIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))

    let focusCommand = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-budget-field","selectorKey":"id","selectorValue":"agent-device-hardware-keyboard-input"}"#
    )
    XCTAssertTrue(try executeOnMainPrepared(command: focusCommand, activeApp: app).ok)

    penalizeSnapshotXCTestChannel(bundleId: nil, reason: "test")
    let frame = textField.frame

    let text = String(
      repeating: "x",
      count: SynthesizedDeliveryBudget.maxTextLength(delaySeconds: 0) + 1
    )
    let command = try runnerCommandFixture(
      #"{"command":"type","commandId":"fill-over-budget","text":"\#(text)","textEntryMode":"replace","x":\#(frame.midX),"y":\#(frame.midY)}"#
    )
    let failuresBeforeType = currentXCTestFailureCount()
    let response = executeTypeCommand(activeApp: app, command: command)

    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_INPUT_SYNTHESIS_BUDGET_EXCEEDED")
    XCTAssertFalse(didRecordXCTestFailure(since: failuresBeforeType))
    XCTAssertEqual(String(describing: textField.value ?? ""), "")
  }
#endif
}
