import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  /// What the app-owned-value fixture reports about the edits it saw. Counts and timings only: the
  /// field's contents never cross into the test. `write-backs` is the only counter this suite acts
  /// on; the others are parsed so a fixture that stops reporting one fails here instead of silently
  /// narrowing what the pacing assertion can see.
  struct AppOwnedFieldStatus {
    let writeBacks: Int
    /// Edits in the latest burst, and the milliseconds between its first and last edit.
    let burstEdits: Int
    let burstMilliseconds: Int
    /// Diagnostic only: XCTest does not space `typingSpeed:` characters evenly, so no pace this
    /// runner could ship promises a closest pair. It names the tightest gap when the average fails.
    let minimumGapMilliseconds: Int
  }

  func appOwnedFieldStatus() throws -> AppOwnedFieldStatus {
    let label = app.staticTexts["agent-device-text-entry-write-backs"].label
    var fields: [String: Int] = [:]
    for pair in label.split(separator: " ") {
      let parts = pair.split(separator: "=")
      if parts.count == 2, let value = Int(parts[1]) { fields[String(parts[0])] = value }
    }
    func field(_ name: String) throws -> Int {
      try XCTUnwrap(fields[name], "fixture status lacks \(name): \(label)")
    }
    return AppOwnedFieldStatus(
      writeBacks: try field("write-backs"),
      burstEdits: try field("burst-edits"),
      burstMilliseconds: try field("burst-ms"),
      minimumGapMilliseconds: try field("min-gap-ms")
    )
  }

  /// Launches the text-entry fixture, focuses its field, and penalizes the XCTest channel, so a
  /// coordinate replacement takes the synthesized first-responder route.
  @MainActor
  func focusSynthesizedReplacementField(extraLaunchArguments: [String] = []) throws -> XCUIElement {
    app.launchArguments = ["--agent-device-text-entry-regression"] + extraLaunchArguments
    app.launch()
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))
    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForExistence(timeout: appExistenceTimeout))
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    mainOwned.processIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))
    let focusCommand = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-replacement-field","selectorKey":"id","selectorValue":"agent-device-hardware-keyboard-input"}"#
    )
    let focusResponse = try executeOnMainPrepared(command: focusCommand, activeApp: app)
    XCTAssertTrue(focusResponse.ok, String(describing: focusResponse.error))
    penalizeSnapshotXCTestChannel(bundleId: nil, reason: "test")
    return textField
  }

  @MainActor
  func replaceSynthesizedFieldText(
    _ textField: XCUIElement,
    text: String,
    commandId: String
  ) throws -> Response {
    let frame = textField.frame
    // Assembled with JSONSerialization so a text carrying a quote or a backslash stays one command
    // rather than invalid JSON.
    let command = try JSONDecoder().decode(
      Command.self,
      from: JSONSerialization.data(withJSONObject: [
        "command": "type",
        "commandId": commandId,
        "text": text,
        "textEntryMode": "replace",
        "x": frame.midX,
        "y": frame.midY,
      ])
    )
    let failuresBeforeType = currentXCTestFailureCount()
    let response = executeTypeCommand(activeApp: app, command: command)
    XCTAssertFalse(didRecordXCTestFailure(since: failuresBeforeType))
    return response
  }

  @MainActor
  func tearDownSynthesizedReplacementField() {
    clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
    invalidateCachedTarget(reason: "unit_test_cleanup")
    app.terminate()
  }

  /// An app that owns its field's value renders it some time after the edit that produced it, the
  /// way a controlled React Native `TextInput` does. A burst typed faster than that render has its
  /// in-flight characters erased by the app's own write, which the app then reads back into its
  /// model, so the field settles stable short of the request — the shape CI reported for
  /// `fill id="field-email" ada@example` as `aexample` (#2080).
  ///
  /// Two halves, each independent of host timing:
  /// - The pace: across a burst, the characters reach the app at least one acknowledge window apart
  ///   on average. At the pre-fix 60 characters per second they arrive about 13 ms apart and this
  ///   goes red. It is an average because XCTest does not space `typingSpeed:` characters evenly —
  ///   two of them can reach the app a few milliseconds apart at any pace — so whether an app with
  ///   this window keeps up with one particular burst is not something the runner can promise.
  /// - The runner's: a field the app rewrote mid-burst never reports ok. An ok over a short value
  ///   was the original defect.
  @MainActor
  func testSynthesizedReplacementPacesAnAppOwnedFieldAtItsAcknowledgeWindow() throws {
    let window = TextEntryTestAssumptions.synthesizedAcknowledgeWindowSeconds
    let textField = try focusSynthesizedReplacementField(extraLaunchArguments: [
      "--agent-device-text-entry-app-owned-value",
      "--agent-device-text-entry-acknowledge-window", String(window),
    ])
    defer { tearDownSynthesizedReplacementField() }

    // Twice: the second replacement selects the first one's value away, which is the shape the
    // reported CI trace had — a `fill` onto a field that already held text.
    for commandId in ["fill-app-owned-first", "fill-app-owned-second"] {
      let before = try appOwnedFieldStatus()
      let response = try replaceSynthesizedFieldText(textField, text: "ada@example", commandId: commandId)
      let after = try appOwnedFieldStatus()

      XCTAssertGreaterThan(after.burstEdits, 1, "the fixture saw no burst")
      XCTAssertGreaterThanOrEqual(
        Double(after.burstMilliseconds),
        Double(after.burstEdits - 1) * window * 1000,
        "\(after.burstEdits) edits reached the app in \(after.burstMilliseconds) ms "
          + "(closest pair \(after.minimumGapMilliseconds) ms)"
      )
      if after.writeBacks == before.writeBacks {
        XCTAssertTrue(response.ok, String(describing: response.error))
        XCTAssertEqual(response.data?.textEntryRoute, "synthesized-first-responder-replacement")
        XCTAssertEqual(String(describing: textField.value ?? ""), "ada@example")
      } else {
        XCTAssertFalse(response.ok, "a field the app rewrote cannot report success")
        XCTAssertEqual(response.error?.code, "TEXT_INPUT_COMMIT_NOT_OBSERVED")
      }
    }
  }

  /// A replacement the command budget cannot carry is refused before the first character is posted,
  /// so a `fill` cannot end in a transport timeout that leaves the runner typing into a field nobody
  /// is waiting for and the next command finding it busy.
  @MainActor
  func testSynthesizedReplacementRefusesTextBeyondTheDeliveryBudget() throws {
    let textField = try focusSynthesizedReplacementField()
    defer { tearDownSynthesizedReplacementField() }

    let text = String(
      repeating: "x",
      count: SynthesizedDeliveryBudget.maxTextLength(delaySeconds: 0) + 1
    )
    let response = try replaceSynthesizedFieldText(textField, text: text, commandId: "fill-over-budget")

    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_INPUT_SYNTHESIS_BUDGET_EXCEEDED")
    XCTAssertEqual(String(describing: textField.value ?? ""), "")
  }
#endif
}
