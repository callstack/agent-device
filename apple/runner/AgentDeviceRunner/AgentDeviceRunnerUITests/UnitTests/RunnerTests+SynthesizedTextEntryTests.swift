import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  /// What the app-owned-value fixture reports about the edits it saw. Counts and timings only: the
  /// field's contents never cross into the test. `write-backs` is the only counter that gates an
  /// outcome; the burst counters feed the pacing assertion and `min-gap-ms` appears only in its
  /// failure message. All are parsed so a fixture that stops reporting one fails here instead of
  /// silently narrowing what the pacing assertion can see.
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

  /// Drops the select-all of the first `remaining` replacing posts, the way a React Native field in
  /// a freshly launched app does, so each of those passes deletes only the last character.
  final class SelectAllDroppingSynthesizer: TextEntrySynthesizing {
    var remaining: Int

    init(dropping count: Int) {
      remaining = count
    }

    func enterText(
      app: XCUIApplication,
      text: String,
      replacingExistingText: Bool
    ) -> SynthesizedTextEntryAction {
      let dropsSelectAll = replacingExistingText && remaining > 0
      if dropsSelectAll { remaining -= 1 }
      return PrivateXCTestTextEntrySynthesizer().enterText(
        app: app,
        text: text,
        replacingExistingText: replacingExistingText && !dropsSelectAll
      )
    }
  }

  /// Two fixed clear passes left "Clie" of "Client" in 3 of 5 fills on a freshly launched React
  /// Native app that dropped its select-alls, and the fill typed after it. The clear now repeats
  /// until the field reads empty, and types nothing over text it could not remove.
  @MainActor
  func testSynthesizedReplacementClearsPastDroppedSelectAlls() throws {
    let field = try focusSynthesizedReplacementField()
    defer { tearDownSynthesizedReplacementField() }
    let frame = field.frame
    let found = try XCTUnwrap(coordinateTapTextInputIdentityAt(app: app, x: frame.midX, y: frame.midY))
    let cases: [(dropped: Int, failure: TextEntryFailure?)] = [
      (2, nil),
      (SynthesizedTextPlan.Step.maxClearPassCount, .clearNotObserved),
    ]

    for testCase in cases {
      let label = "\(testCase.dropped) select-alls dropped"
      let seeded = try replaceSynthesizedFieldText(field, text: "stale", commandId: "seed-\(testCase.dropped)")
      XCTAssertTrue(seeded.ok, String(describing: seeded.error))
      let result = typeTextReliably(
        app: app,
        target: TextEntryTarget(
          element: nil,
          refreshPoint: CGPoint(x: frame.midX, y: frame.midY),
          prefersFocusedElement: false,
          inputAtRefreshPoint: found
        ),
        text: "fresh",
        delaySeconds: 0,
        repairMode: .replacement,
        xCTestChannelPenalized: true,
        synthesizer: SelectAllDroppingSynthesizer(dropping: testCase.dropped)
      )

      let value = String(describing: field.value ?? "")
      XCTAssertEqual(result.failure, testCase.failure, label)
      if testCase.failure == nil {
        XCTAssertEqual(value, "fresh", label)
      } else {
        XCTAssertFalse(value.contains("fresh"), "typed over text it could not clear: \(value)")
        XCTAssertFalse(value.isEmpty, label)
      }
    }
  }

  /// Launches the fixture whose field moves away when focused and leaves a neighbouring field under
  /// the point the focus tap hit, the way a React Native bottom sheet extends above the keyboard.
  /// The field is not focused yet, so the replacement's own tap starts the move.
  @MainActor
  func launchFieldThatMovesOnFocus() throws -> (field: XCUIElement, neighbour: XCUIElement) {
    app.launchArguments = ["--agent-device-text-entry-regression", "--agent-device-text-entry-moves-on-focus"]
    app.launch()
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    let neighbour = app.textFields["agent-device-text-entry-neighbour"]
    XCTAssertTrue(field.waitForExistence(timeout: appExistenceTimeout))
    XCTAssertTrue(neighbour.waitForExistence(timeout: appExistenceTimeout))
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    mainOwned.processIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))
    penalizeSnapshotXCTestChannel(bundleId: nil, reason: "test")
    return (field, neighbour)
  }

  /// The commit wait used to re-read whatever field sat under the pre-focus point, which after the
  /// move is the neighbour, so a replacement that landed was reported as
  /// TEXT_INPUT_COMMIT_NOT_OBSERVED.
  @MainActor
  func testSynthesizedReplacementConfirmsAFieldThatMovedOnFocus() throws {
    let (field, neighbour) = try launchFieldThatMovesOnFocus()
    defer { tearDownSynthesizedReplacementField() }
    let pointBeforeFocus = field.frame

    let response = try replaceSynthesizedFieldText(field, text: "fresh", commandId: "fill-moved-field")

    XCTAssertNotEqual(field.frame.midY, pointBeforeFocus.midY, "the fixture field did not move")
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(String(describing: field.value ?? ""), "fresh")
    XCTAssertEqual(String(describing: neighbour.value ?? ""), "neighbour")
  }

  /// `fill ""` used to clear whatever field the move left under the pre-focus point, and report
  /// success because that field was then empty.
  @MainActor
  func testSynthesizedClearEmptiesTheFieldThatMovedOnFocus() throws {
    let (field, neighbour) = try launchFieldThatMovesOnFocus()
    defer { tearDownSynthesizedReplacementField() }

    let response = try replaceSynthesizedFieldText(field, text: "", commandId: "clear-moved-field")

    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(String(describing: field.value ?? ""), "")
    XCTAssertEqual(String(describing: neighbour.value ?? ""), "neighbour")
  }

  /// Once the input under the point was found before the tap, the point no longer names the field.
  /// A handle that re-bound to another input (one inserted or reordered ahead of it) or no longer
  /// resolves used to fall through to that input, or to whatever sat under the point, and `fill ""`
  /// cleared it. Without an identifier, as on a React Native input with no testID, nothing else can
  /// name the input, so the clear fails closed.
  @MainActor
  func testSynthesizedClearFailsClosedWhenTheInputFoundUnderThePointIsGone() throws {
    let (field, neighbour) = try launchFieldThatMovesOnFocus()
    defer { tearDownSynthesizedReplacementField() }
    let rebound = app.textFields.element(boundBy: 1)
    XCTAssertEqual(rebound.identifier, "agent-device-text-entry-neighbour")
    let neighbourFrame = neighbour.frame
    let found = [
      "re-bound": TextInputAtPoint(element: rebound, identity: TextEntryInputIdentity(elementType: .textField, identifier: "")),
      "missing": TextInputAtPoint(
        element: app.textFields["agent-device-gone"],
        identity: TextEntryInputIdentity(elementType: .textField, identifier: "agent-device-gone")
      ),
    ]

    for (handle, inputAtRefreshPoint) in found {
      let result = typeTextReliably(
        app: app,
        target: TextEntryTarget(
          element: nil,
          refreshPoint: CGPoint(x: neighbourFrame.midX, y: neighbourFrame.midY),
          prefersFocusedElement: false,
          inputAtRefreshPoint: inputAtRefreshPoint
        ),
        text: "",
        delaySeconds: 0,
        repairMode: .replacement,
        xCTestChannelPenalized: true,
        synthesizer: RecordingTextEntrySynthesizer()
      )

      XCTAssertEqual(result.failure, .notFocused, handle)
      XCTAssertEqual(String(describing: neighbour.value ?? ""), "neighbour", handle)
      XCTAssertEqual(String(describing: field.value ?? ""), "stale", handle)
    }
  }

  /// An input found with an identifier stays reachable after its handle re-binds: the bound
  /// identity finds it app-wide, so `fill ""` clears it, and never the input the handle now names
  /// or the one under the point.
  @MainActor
  func testSynthesizedClearFindsAnIdentifiedInputWhoseHandleReBound() throws {
    let (field, neighbour) = try launchFieldThatMovesOnFocus()
    defer { tearDownSynthesizedReplacementField() }
    let rebound = app.textFields.element(boundBy: 1)
    XCTAssertEqual(rebound.identifier, "agent-device-text-entry-neighbour")
    let neighbourFrame = neighbour.frame

    let result = typeTextReliably(
      app: app,
      target: TextEntryTarget(
        element: nil,
        refreshPoint: CGPoint(x: neighbourFrame.midX, y: neighbourFrame.midY),
        prefersFocusedElement: false,
        inputAtRefreshPoint: TextInputAtPoint(
          element: rebound,
          identity: TextEntryInputIdentity(elementType: .textField, identifier: field.identifier)
        )
      ),
      text: "",
      delaySeconds: 0,
      repairMode: .replacement,
      xCTestChannelPenalized: true,
      synthesizer: RecordingTextEntrySynthesizer()
    )

    XCTAssertNil(result.failure)
    XCTAssertEqual(String(describing: field.value ?? ""), "")
    XCTAssertEqual(String(describing: neighbour.value ?? ""), "neighbour")
  }

  /// Checking that the found input still resolves reads its handle again on the penalized channel.
  /// A read that cannot answer used to record the failure, which fails the command and ends the
  /// runner. The handle here matches both inputs, so its snapshot cannot answer, and the input has
  /// no identifier to be found by instead.
  @MainActor
  func testSynthesizedClearFailsClosedWhenTheInputFoundUnderThePointCannotBeRead() throws {
    let (field, neighbour) = try launchFieldThatMovesOnFocus()
    defer { tearDownSynthesizedReplacementField() }
    let neighbourFrame = neighbour.frame
    let failures = currentXCTestFailureCount()

    let result = typeTextReliably(
      app: app,
      target: TextEntryTarget(
        element: nil,
        refreshPoint: CGPoint(x: neighbourFrame.midX, y: neighbourFrame.midY),
        prefersFocusedElement: false,
        inputAtRefreshPoint: TextInputAtPoint(
          element: app.textFields.element,
          identity: TextEntryInputIdentity(elementType: .textField, identifier: "")
        )
      ),
      text: "",
      delaySeconds: 0,
      repairMode: .replacement,
      xCTestChannelPenalized: true,
      synthesizer: RecordingTextEntrySynthesizer()
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failures))
    XCTAssertEqual(result.failure, .notFocused)
    XCTAssertEqual(String(describing: neighbour.value ?? ""), "neighbour")
    XCTAssertEqual(String(describing: field.value ?? ""), "stale")
  }

  /// The pre-tap lookup runs on a channel already penalized for failing XCTest reads. A lookup that
  /// fails leaves the fill to the point; it used to record the failure, which fails the command
  /// and ends the runner.
  @MainActor
  func testSynthesizedReplacementContainsAFailedLookupOfTheInputUnderThePoint() throws {
    let textField = try focusSynthesizedReplacementField()
    defer {
      textInputProbeIssueForTesting = nil
      tearDownSynthesizedReplacementField()
    }
    textInputProbeIssueForTesting = XCTIssue(
      type: .assertionFailure,
      compactDescription: "Injected pre-tap text input query failure"
    )

    let response = try replaceSynthesizedFieldText(textField, text: "fresh", commandId: "fill-lookup-failed")

    XCTAssertNil(textInputProbeIssueForTesting, "the fill made no lookup")
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(String(describing: textField.value ?? ""), "fresh")
  }
#endif
}
