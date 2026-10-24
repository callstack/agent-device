import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  /// The readiness retap dispatches `ResolvedTextEntryInput.frameOnScreen`'s center, so the snapshot
  /// frame of a placed window passes through the read's content vector before it becomes a screen
  /// point (#3899). Before that rule the retap tapped the bare `snapshot().frame` center, which on
  /// a windowed iPad lands outside the window, and the fill after it failed with
  /// TEXT_INPUT_NOT_FOCUSED — the issue's own failure shape.
  ///
  /// The fixture cannot be placed in a window, so the read is driven directly: the vector moves the
  /// field's real snapshot frame exactly onto the press-counting witness button below it. A point
  /// dispatched at `frameOnScreen`'s center presses that button; a point dispatched at the raw
  /// snapshot center taps the field and moves no counter. The same read with no vector is the
  /// closest negative: a full-screen app retaps the field itself and the counter stays put.
  @MainActor
  func testReadinessRetapDispatchesTheReadsScreenSpaceCenter() throws {
    app.launchArguments = ["--agent-device-text-entry-regression", "--agent-device-text-entry-tap-witness"]
    app.launch()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    let witness = app.buttons["agent-device-tap-witness"]
    XCTAssertTrue(witness.waitForFixtureExistence(timeout: appExistenceTimeout))
    let presses = app.staticTexts["agent-device-tap-witness-presses"]
    XCTAssertTrue(presses.waitForFixtureExistence(timeout: appExistenceTimeout))
    let fieldFrame = field.frame
    let witnessFrame = witness.frame
    XCTAssertFalse(fieldFrame.isEmpty)
    XCTAssertFalse(witnessFrame.isEmpty)

    // Closest negative: a read with no vector — a full-screen app — retaps the field's own center,
    // which is not the button's point.
    let untranslated = try XCTUnwrap(ResolvedTextEntryInput(reading: field, contentTranslation: nil))
    retapAt(read: untranslated, app: app, element: field)
    XCTAssertEqual(presses.label, "presses=0", "a vectorless read dispatched a point off the field")

    // The read a probe makes on a placed window: the snapshot reports the field's box and the read
    // carries the window's vector. Here the vector is chosen so the translated box is the button.
    let vector = CGSize(
      width: witnessFrame.midX - fieldFrame.midX,
      height: witnessFrame.midY - fieldFrame.midY
    )
    let translated = try XCTUnwrap(ResolvedTextEntryInput(reading: field, contentTranslation: vector))
    XCTAssertEqual(translated.frameOnScreen.midX, witnessFrame.midX, accuracy: 0.5)
    XCTAssertEqual(translated.frameOnScreen.midY, witnessFrame.midY, accuracy: 0.5)

    retapAt(read: translated, app: app, element: field)
    XCTAssertEqual(
      presses.label,
      "presses=1",
      "the retap dispatched the raw snapshot center, not the read's screen-space center (#3899)"
    )
  }
#endif
}
