import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  /// Reads the fixture's `Edits: n; write-backs: m` counter. Counts only: the field's contents never
  /// cross into the test.
  private func textEntryFixtureCounts(app: XCUIApplication) throws -> (edits: Int, writeBacks: Int) {
    let counts = app.staticTexts["agent-device-text-entry-write-backs"].label
      .split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
    XCTAssertEqual(counts.count, 2, "unexpected write-back status: \(counts)")
    return (try XCTUnwrap(counts.first), try XCTUnwrap(counts.last))
  }

  /// An app that owns its field's value renders it some time after the edit that produced it, the
  /// way a controlled React Native `TextInput` does. A burst typed faster than that render has its
  /// in-flight characters erased by the app's own write, which the app then reads back into its
  /// model, so the field settles stable short of the request — the shape CI reported for
  /// `fill id="field-email" ada@example` as `aexample`.
  ///
  /// What this pins is the runner's half of that race, which is all the runner owns: a field the app
  /// rewrote mid-burst either ends with the requested text and an ok, or the command refuses. An ok
  /// over a short value was the original defect. Whether the app wins a round trip is decided by the
  /// host, not by the pace, because XCTest does not deliver `typingSpeed:` characters evenly — CI
  /// observed two of them 4 ms apart at the shipped pace — so the assertion follows the fixture's own
  /// counter rather than assuming the app kept up.
  ///
  /// The pace itself is pinned without a race by `testSynthesizedPaceLeavesRoomForAnAppToAcknowledgeEachEdit`,
  /// against the 40 ms window this route is sized for. The window here is 5 ms — an app that renders
  /// every edit within it is one the shipped pace is not expected to outrun, so the strict branch is
  /// the one a healthy host takes. At the pre-fix 60-characters-per-second pace and the 40 ms policy
  /// window the same run leaves the field holding `a` after 20 write-backs, which is the half the
  /// pace exists for.
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
    var sawKeepUp = false
    var sawRewrite = false

    // Twice: the second replacement selects the first one's value away, which is the shape the
    // reported CI trace had — a `fill` onto a field that already held text.
    for commandId in ["fill-app-owned-first", "fill-app-owned-second"] {
      let command = try runnerCommandFixture(
        #"{"command":"type","commandId":"\#(commandId)","text":"ada@example","textEntryMode":"replace","x":\#(frame.midX),"y":\#(frame.midY)}"#
      )
      let writeBacksBefore = try textEntryFixtureCounts(app: app).writeBacks
      let failuresBeforeType = currentXCTestFailureCount()
      let response = executeTypeCommand(activeApp: app, command: command)
      XCTAssertFalse(didRecordXCTestFailure(since: failuresBeforeType))
      let writeBacksAfter = try textEntryFixtureCounts(app: app).writeBacks

      if writeBacksAfter == writeBacksBefore {
        sawKeepUp = true
        XCTAssertTrue(response.ok, String(describing: response.error))
        XCTAssertEqual(response.data?.textEntryRoute, "synthesized-first-responder-replacement")
        XCTAssertEqual(String(describing: textField.value ?? ""), "ada@example")
      } else {
        sawRewrite = true
        XCTAssertFalse(response.ok, "a field the app rewrote cannot report success")
        XCTAssertEqual(response.error?.code, "TEXT_INPUT_COMMIT_NOT_OBSERVED")
      }
    }

    // The fixture has to have run for either branch above to mean anything.
    XCTAssertGreaterThan(try textEntryFixtureCounts(app: app).edits, 0)
    if sawRewrite {
      NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_APP_OWNED_VALUE branch=app-won-round-trip")
    }
    XCTAssertTrue(sawKeepUp || sawRewrite)
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
