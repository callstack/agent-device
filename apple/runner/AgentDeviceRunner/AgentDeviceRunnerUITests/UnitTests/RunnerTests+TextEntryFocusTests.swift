import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  @MainActor
  func testFocusedReplacementAndClearDispatchNoFocusOrCaretTap() throws {
    for (prefilled, text) in [(false, "hello"), (true, "hello"), (true, "")] {
      let field = try launchTextEntryWitness(prefilled: prefilled)
      defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
      field.tap()
      XCTAssertTrue(keyboardFocusConfirmed(app: app, element: field))
      XCTAssertEqual(try textEntryWitnessCounts().taps, 1)

      let counts = try assertWitnessEntry(field, text: text)
      XCTAssertEqual(counts.taps, 1)
      XCTAssertEqual(counts.selections, prefilled ? 1 : 0)
      XCTAssertEqual(counts.rejected, 0)
    }
  }

  @MainActor
  func testReplacementReadsFocusAgainAfterAnotherInputTakesIt() throws {
    let field = try launchTextEntryWitness(extra: ["--agent-device-text-entry-moves-on-focus"])
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    field.tap()
    XCTAssertTrue(try executeWitnessEntry(field, text: "first").ok)
    let neighbour = app.textFields["agent-device-text-entry-neighbour"]
    neighbour.tap()
    XCTAssertTrue(keyboardFocusConfirmed(app: app, element: neighbour))
    XCTAssertFalse(keyboardFocusConfirmed(app: app, element: field))

    let response = try executeWitnessEntry(field, text: "second")

    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(app.staticTexts["agent-device-text-entry-value-reads"].value as? String, "second")
    XCTAssertEqual(neighbour.value as? String, "neighbour")
    XCTAssertEqual(try textEntryWitnessCounts().taps, 3)
  }

  @MainActor
  func testFocusedUnidentifiedReplacementKeepsFocusAndCaretPreparation() throws {
    let field = try launchTextEntryWitness(prefilled: true, extra: ["--agent-device-text-entry-unnamed-input"])
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    field.tap()
    XCTAssertTrue(keyboardFocusConfirmed(app: app, element: field))

    let counts = try assertWitnessEntry(field, text: "hello")

    XCTAssertEqual(counts.taps, 3)
  }

  @MainActor
  func testNewlyFocusedReplacementKeepsCaretPreparation() throws {
    let field = try launchTextEntryWitness(prefilled: true)
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    XCTAssertFalse(keyboardFocusConfirmed(app: app, element: field))

    let counts = try assertWitnessEntry(field, text: "hello")
    XCTAssertEqual(counts.taps, 2)
  }

  @MainActor
  func testFocusedAppendKeepsItsFocusTap() throws {
    let field = try launchTextEntryWitness()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    field.tap()

    let response = try executeWitnessEntry(field, text: "hello", mode: "append")

    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(app.staticTexts["agent-device-text-entry-value-reads"].value as? String, "hello")
    XCTAssertEqual(try textEntryWitnessCounts().taps, 2)
    XCTAssertEqual(try textEntryWitnessCounts().selections, 0)
  }

  @MainActor
  func testFocusedClearMovesCaretForRejectedSelectAllDeletion() throws {
    for text in ["", "hello"] {
      let field = try launchTextEntryWitness(prefilled: true, extra: ["--agent-device-text-entry-witness-refuse-selection"])
      defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
      field.tap()

      let counts = try assertWitnessEntry(field, text: text)
      XCTAssertEqual(counts.taps, 2)
      XCTAssertGreaterThan(counts.rejected, 0)
    }
  }

  @MainActor
  func testFocusedClearDoesNotContinueIntoAReplacementInput() throws {
    let field = try launchTextEntryWitness(prefilled: true, extra: ["--agent-device-text-entry-populated-successor"])
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    field.tap()
    let failures = currentXCTestFailureCount()

    let response = try executeWitnessEntry(field, text: "")

    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertFalse(didRecordXCTestFailure(since: failures))
    XCTAssertEqual(app.textFields["agent-device-auto-submit-next-screen-input"].value as? String, "next screen value")
    XCTAssertFalse(field.exists)
  }

  @MainActor
  func testFocusedClearReportsRejectedEditsInsteadOfSuccess() throws {
    let field = try launchTextEntryWitness(prefilled: true, extra: ["--agent-device-text-entry-witness-refuse-edits"])
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    field.tap()

    let response = try executeWitnessEntry(field, text: "")

    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_ENTRY_MISMATCH")
    XCTAssertEqual(app.staticTexts["agent-device-text-entry-value-reads"].value as? String, "seedvalue")
    XCTAssertGreaterThan(try textEntryWitnessCounts().rejected, 0)
  }

  @MainActor
  func testLandscapeReplacementDispatchPreservesFocusedAndPenalizedRoutes() throws {
    for orientation in [UIDeviceOrientation.landscapeLeft, .landscapeRight] {
      let field = try launchTextEntryWitness(prefilled: true)
      defer {
        XCUIDevice.shared.orientation = .portrait
        tearDownSynthesizedReplacementField()
      }
      XCUIDevice.shared.orientation = orientation
      let expected = orientation == .landscapeLeft
        ? RunnerInterfaceOrientation.landscapeRight : RunnerInterfaceOrientation.landscapeLeft
      let landscape = XCTNSPredicateExpectation(
        predicate: NSPredicate { _, _ in
          Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: self.app)) == expected
        }, object: app
      )
      XCTAssertEqual(XCTWaiter.wait(for: [landscape], timeout: 5), .completed)
      field.tap()
      let initialTaps = try textEntryWitnessCounts().taps

      let focused = try executeWitnessEntry(field, text: "hello", prepared: true)
      XCTAssertTrue(focused.ok, String(describing: focused.error))
      XCTAssertEqual(try textEntryWitnessCounts().taps, initialTaps)
      XCTAssertEqual(app.staticTexts["agent-device-text-entry-value-reads"].value as? String, "hello")

      penalizeSnapshotXCTestChannel(bundleId: nil, reason: "test")
      let penalized = try executeWitnessEntry(field, text: "fresh", prepared: true)
      XCTAssertTrue(penalized.ok, String(describing: penalized.error))
      XCTAssertEqual(penalized.data?.textEntryRoute, "synthesized-first-responder-replacement")
      XCTAssertGreaterThan(try textEntryWitnessCounts().taps, initialTaps)
      XCTAssertEqual(app.staticTexts["agent-device-text-entry-value-reads"].value as? String, "fresh")
      let cleared = try executeWitnessEntry(field, text: "", prepared: true)
      XCTAssertTrue(cleared.ok, String(describing: cleared.error))
      XCTAssertEqual(app.staticTexts["agent-device-text-entry-value-reads"].value as? String, "")
    }
  }

  @MainActor
  private func launchTextEntryWitness(prefilled: Bool = false, extra: [String] = []) throws -> XCUIElement {
    app.launchArguments = ["--agent-device-text-entry-regression", "--agent-device-text-entry-witness"]
      + (prefilled ? ["--agent-device-text-entry-witness-prefill"] : []) + extra
    app.launch()
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let field = extra.contains("--agent-device-text-entry-unnamed-input")
      ? app.textFields.firstMatch : app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    return field
  }

  @MainActor
  private func executeWitnessEntry(_ field: XCUIElement, text: String, mode: String = "replace", prepared: Bool = false) throws -> Response {
    let frame = field.frame
    let command = try runnerCommandFixture(
      #"{"command":"type","text":"\#(text)","textEntryMode":"\#(mode)","x":\#(frame.midX),"y":\#(frame.midY)}"#
    )
    if prepared {
      return try executeOnMainPrepared(command: command, activeApp: app)
    }
    return try executeTypeCommand(activeApp: app, command: command)
  }

  @MainActor
  private func assertWitnessEntry(_ field: XCUIElement, text: String) throws -> (taps: Int, selections: Int, rejected: Int) {
    let response = try executeWitnessEntry(field, text: text)
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(app.staticTexts["agent-device-text-entry-value-reads"].value as? String, text)
    return try textEntryWitnessCounts()
  }

  @MainActor
  private func textEntryWitnessCounts() throws -> (taps: Int, selections: Int, rejected: Int) {
    let hint = app.staticTexts["agent-device-text-entry-value-reads"].label
    let counts = try hint.split(separator: " ").map { field in
      try XCTUnwrap(Int(try XCTUnwrap(field.split(separator: "=").last).description))
    }
    guard counts.count == 3 else {
      XCTFail("Missing app-owned text entry counters: \(hint)")
      return (0, 0, 0)
    }
    return (counts[0], counts[1], counts[2])
  }
#endif
}
