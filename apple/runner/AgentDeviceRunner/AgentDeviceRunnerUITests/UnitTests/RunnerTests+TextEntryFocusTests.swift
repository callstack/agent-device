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
  func testFillWithKeyboardDownTypesIntoTheSheetInputNotTheOneItCovers() throws {
    for delayMs in [0, 80] {
      let (foreground, background) = try launchOverlappingSheet()
      defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
      try assertOverlappingSheetFill(foreground: foreground, background: background, delayMs: delayMs)
    }
  }

  @MainActor
  func testFillWithKeyboardUpTypesIntoTheSheetInputNotTheOneItCovers() throws {
    for delayMs in [0, 80] {
      let (foreground, background) = try launchOverlappingSheet()
      defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
      app.textFields["agent-device-overlap-sheet-neighbour"].tap()
      try XCTSkipUnless(
        app.keyboards.firstMatch.waitForFixtureExistence(timeout: appExistenceTimeout),
        "software keyboard is down: this simulator cannot exercise the keyboard-visible fill branch"
      )
      try assertOverlappingSheetFill(foreground: foreground, background: background, delayMs: delayMs)
    }
  }

  /// The sheet input refuses focus, so the neighbour that held it keeps it. On either channel the
  /// fill refuses before any clear or typing, which would otherwise reach that neighbour.
  @MainActor
  func testFillRefusesAndKeepsTheFocusedFieldWhenTheSheetInputUnderThePointTakesNoFocus() throws {
    for (penalized, delayMs) in [(false, 0), (true, 0), (true, 80)] {
      let context = "penalized=\(penalized) delayMs=\(delayMs)"
      let (foreground, background) = try launchOverlappingSheet(extra: ["--agent-device-text-entry-overlapping-sheet-refuses-focus"])
      defer { tearDownSynthesizedReplacementField() }
      let neighbour = app.textFields["agent-device-overlap-sheet-neighbour"]
      neighbour.tap()
      XCTAssertTrue(keyboardFocusConfirmed(app: app, element: neighbour), context)
      if penalized { try penalizeOverlappingFixtureChannel() }
      let failures = currentXCTestFailureCount()

      let response = try executeWitnessEntry(foreground, text: "sheetvalue", delayMs: delayMs)

      XCTAssertFalse(response.ok, context)
      XCTAssertEqual(response.error?.code, "TEXT_INPUT_NOT_FOCUSED", context)
      XCTAssertFalse(didRecordXCTestFailure(since: failures), context)
      XCTAssertEqual(foreground.value as? String, "stale", context)
      XCTAssertEqual(background.value as? String, "background", context)
      XCTAssertEqual(neighbour.value as? String, "neighbour", context)
    }
  }

  /// The popover's field covers the fill's point but not the center of the smaller field under it,
  /// so XCTest reports both hittable and size alone picks the field under the popover. On either
  /// channel, with or without that field focused first, the fill types into the popover's field.
  @MainActor
  func testFillAtAPointAPopoverCoversTypesIntoThePopoverFieldNotTheFieldUnderIt() throws {
    for penalized in [false, true] {
      for focusUnderFirst in [false, true] {
        let context = "penalized=\(penalized) focusUnderFirst=\(focusUnderFirst)"
        let (popoverField, partlyCovered, point) = try launchOverlappingPopover()
        defer { tearDownSynthesizedReplacementField() }
        if focusUnderFirst {
          partlyCovered.tap()
          XCTAssertTrue(keyboardFocusConfirmed(app: app, element: partlyCovered), context)
        }
        if penalized { try penalizeOverlappingFixtureChannel() }
        let failures = currentXCTestFailureCount()

        let response = try executeWitnessEntry(popoverField, text: "popovervalue", at: point)

        XCTAssertTrue(response.ok, "\(context): \(String(describing: response.error))")
        XCTAssertFalse(didRecordXCTestFailure(since: failures), context)
        XCTAssertEqual(popoverField.value as? String, "popovervalue", context)
        XCTAssertEqual(partlyCovered.value as? String, "background", context)
      }
    }
  }

  /// The overlapping-sheet fixture, with the shape its tests depend on checked first: the sheet
  /// input's center also lies in the input the sheet covers, which is the smaller of the two and
  /// which XCTest reports not hittable.
  @MainActor
  private func launchOverlappingSheet(extra: [String] = []) throws -> (foreground: XCUIElement, background: XCUIElement) {
    let (foreground, background) = launchOverlappingInputs(
      ["--agent-device-text-entry-overlapping-sheet"] + extra,
      top: "agent-device-overlap-foreground-input",
      under: "agent-device-overlap-background-input"
    )
    let sheetFrame = foreground.frame
    let coveredFrame = background.frame
    XCTAssertTrue(coveredFrame.contains(CGPoint(x: sheetFrame.midX, y: sheetFrame.midY)))
    XCTAssertLessThan(coveredFrame.width * coveredFrame.height, sheetFrame.width * sheetFrame.height)
    XCTAssertFalse(background.isHittable)
    return (foreground, background)
  }

  /// The overlapping-popover fixture, with the shape its test depends on checked first: a point in
  /// both fields, the partly covered field the smaller, its center outside the popover's field, and
  /// both fields hittable.
  @MainActor
  private func launchOverlappingPopover() throws -> (popoverField: XCUIElement, partlyCovered: XCUIElement, point: CGPoint) {
    let (popoverField, partlyCovered) = launchOverlappingInputs(
      ["--agent-device-text-entry-overlapping-popover"],
      top: "agent-device-popover-input",
      under: "agent-device-popover-partly-covered-input"
    )
    let popoverFrame = popoverField.frame
    let coveredFrame = partlyCovered.frame
    let point = CGPoint(x: (popoverFrame.minX + coveredFrame.maxX) / 2, y: coveredFrame.midY)
    XCTAssertTrue(popoverFrame.contains(point))
    XCTAssertTrue(coveredFrame.contains(point))
    XCTAssertFalse(popoverFrame.contains(CGPoint(x: coveredFrame.midX, y: coveredFrame.midY)))
    XCTAssertLessThan(coveredFrame.width * coveredFrame.height, popoverFrame.width * popoverFrame.height)
    XCTAssertTrue(partlyCovered.isHittable)
    XCTAssertTrue(popoverField.isHittable)
    return (popoverField, partlyCovered, point)
  }

  @MainActor
  private func launchOverlappingInputs(_ arguments: [String], top: String, under: String) -> (top: XCUIElement, under: XCUIElement) {
    app.launchArguments = arguments
    app.launch()
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let topField = app.textFields[top]
    let underField = app.textFields[under]
    XCTAssertTrue(topField.waitForFixtureExistence(timeout: appExistenceTimeout))
    XCTAssertTrue(underField.exists)
    return (topField, underField)
  }

  /// Penalizes the XCTest channel for the running fixture, which routes a coordinate fill through
  /// synthesized focus and typing.
  @MainActor
  private func penalizeOverlappingFixtureChannel() throws {
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    mainOwned.processIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))
    penalizeSnapshotXCTestChannel(bundleId: nil, reason: "test")
  }

  @MainActor
  private func assertOverlappingSheetFill(foreground: XCUIElement, background: XCUIElement, delayMs: Int) throws {
    let failures = currentXCTestFailureCount()
    let response = try executeWitnessEntry(foreground, text: "sheetvalue", delayMs: delayMs)
    XCTAssertTrue(response.ok, "delayMs=\(delayMs): \(String(describing: response.error))")
    XCTAssertFalse(didRecordXCTestFailure(since: failures), "delayMs=\(delayMs)")
    XCTAssertEqual(foreground.value as? String, "sheetvalue", "delayMs=\(delayMs)")
    XCTAssertEqual(background.value as? String, "background", "delayMs=\(delayMs)")
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
  private func executeWitnessEntry(
    _ field: XCUIElement,
    text: String,
    mode: String = "replace",
    delayMs: Int = 0,
    at point: CGPoint? = nil,
    prepared: Bool = false
  ) throws -> Response {
    let aim = point ?? CGPoint(x: field.frame.midX, y: field.frame.midY)
    let command = try runnerCommandFixture(
      #"{"command":"type","text":"\#(text)","textEntryMode":"\#(mode)","x":\#(aim.x),"y":\#(aim.y),"delayMs":\#(delayMs)}"#
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
