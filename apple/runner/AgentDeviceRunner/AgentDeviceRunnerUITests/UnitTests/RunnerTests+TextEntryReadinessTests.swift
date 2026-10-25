import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  /// #3899: the readiness retap dispatches the read's screen box, not its raw snapshot frame. The
  /// fixture cannot be placed in a window, so a `.known` vector moves the field's snapshot frame onto
  /// the press-counting witness button: only a retap through `frameOnScreen` presses it. An
  /// `.unknown` vector names no box and taps nothing; `.none` retaps the field itself.
  @MainActor
  func testReadinessRetapDispatchesTheReadsScreenSpaceCenter() throws {
    app.launchArguments = ["--agent-device-text-entry-regression", "--agent-device-text-entry-tap-witness"]
    app.launch()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    let witness = app.buttons["agent-device-tap-witness"]
    let presses = app.staticTexts["agent-device-tap-witness-presses"]
    for element in [field, witness, presses] {
      XCTAssertTrue(element.waitForFixtureExistence(timeout: appExistenceTimeout))
    }
    let fieldFrame = field.frame
    let witnessFrame = witness.frame

    let unknown = try XCTUnwrap(ResolvedTextEntryInput(reading: field, contentTranslation: .unknown))
    XCTAssertNil(unknown.frameOnScreen)
    retapAt(read: unknown, app: app, element: field)
    XCTAssertEqual(presses.label, "presses=0", "an unknown content space dispatched a point")

    retapAt(read: try XCTUnwrap(ResolvedTextEntryInput(reading: field, contentTranslation: .none)), app: app, element: field)
    XCTAssertEqual(presses.label, "presses=0", "a full-screen read dispatched a point off the field")

    let vector = CGSize(width: witnessFrame.midX - fieldFrame.midX, height: witnessFrame.midY - fieldFrame.midY)
    retapAt(read: try XCTUnwrap(ResolvedTextEntryInput(reading: field, contentTranslation: .known(vector))), app: app, element: field)
    XCTAssertEqual(presses.label, "presses=1", "the retap dispatched the raw snapshot center, not the screen-space one")
  }
#endif
}
