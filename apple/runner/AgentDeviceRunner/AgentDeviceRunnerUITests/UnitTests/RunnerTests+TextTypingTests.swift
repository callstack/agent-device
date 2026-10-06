import XCTest

// Command-level `type` coverage in the request shapes the daemon sends: ordinary text in
// `textEntryMode: "append"`, and the bare submit key with no mode.
extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  @MainActor
  func testTypeWithoutResolvedInputReturnsTypedFailureBeforeDispatchingText() throws {
    let command = try runnerCommandFixture(
      #"{"command":"type","commandId":"type-without-focus","text":"hello","textEntryMode":"append"}"#
    )

    let response = executeTypeCommand(
      activeApp: XCUIApplication(bundleIdentifier: "com.example.agentdevice.missing-input"),
      command: command
    )

    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_INPUT_NOT_FOCUSED")
    XCTAssertEqual(
      response.error?.hint,
      "Focus a visible text input, then retry type or fill. If the input is not exposed by accessibility, use a coordinate focus command before typing."
    )
  }

  @MainActor
  func testBareTypeUsesTappedInputWhenSoftwareKeyboardIsHidden() throws {
    // The fixture uses a real text responder with an empty input view to model hardware-keyboard input.
    let textField = try launchHardwareKeyboardFixture()
    try tapHardwareKeyboardInput(commandId: "tap-hardware-keyboard-input")
    try skipUnlessSoftwareKeyboardIsHidden()

    let failureCountBefore = currentXCTestFailureCount()
    let typeResponse = executeTypeCommand(
      activeApp: app,
      command: try runnerCommandFixture(
        #"{"command":"type","commandId":"type-hardware-keyboard","text":"hardware-keyboard","textEntryMode":"append"}"#
      )
    )

    XCTAssertTrue(typeResponse.ok, String(describing: typeResponse.error))
    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertEqual(typeResponse.data?.textEntryRoute, "xctest-element")
    XCTAssertNil(textEntryTapWitness, "the type must consume the tap witness it was addressed by")
    XCTAssertEqual(textField.value as? String, "hardware-keyboard")

    // The tap witness is one-shot: a second bare type without a new tap has no target.
    let unfocusedFailureCountBefore = currentXCTestFailureCount()
    let unfocusedResponse = executeTypeCommand(
      activeApp: app,
      command: try runnerCommandFixture(
        #"{"command":"type","commandId":"type-hardware-keyboard-unfocused","text":"-again","textEntryMode":"append"}"#
      )
    )

    XCTAssertFalse(unfocusedResponse.ok)
    XCTAssertEqual(unfocusedResponse.error?.code, "TEXT_INPUT_NOT_FOCUSED")
    XCTAssertFalse(didRecordXCTestFailure(since: unfocusedFailureCountBefore))
    XCTAssertEqual(textField.value as? String, "hardware-keyboard")

    try tapHardwareKeyboardInput(commandId: "tap-hardware-keyboard-input-again")
    // The first tap already proved this simulator keeps the keyboard down for the fixture, so a
    // keyboard here is a product change, not an environment fact.
    XCTAssertFalse(isKeyboardVisible(app: app))
    let appendFailureCountBefore = currentXCTestFailureCount()
    let appendResponse = executeTypeCommand(
      activeApp: app,
      command: try runnerCommandFixture(
        #"{"command":"type","commandId":"type-hardware-keyboard-again","text":"-again","textEntryMode":"append"}"#
      )
    )

    XCTAssertTrue(appendResponse.ok, String(describing: appendResponse.error))
    XCTAssertFalse(didRecordXCTestFailure(since: appendFailureCountBefore))
    XCTAssertEqual(appendResponse.data?.textEntryRoute, "xctest-element")
    XCTAssertEqual(textField.value as? String, "hardware-keyboard-again")
  }

  @MainActor
  func testBareSubmitKeyUsesSynthesizedFirstResponderAfterHiddenKeyboardTap() throws {
    _ = try launchHardwareKeyboardFixture()
    try tapHardwareKeyboardInput(commandId: "tap-hardware-keyboard-submit")
    try skipUnlessSoftwareKeyboardIsHidden()

    let failureCountBefore = currentXCTestFailureCount()
    let submitResponse = executeTypeCommand(
      activeApp: app,
      command: try runnerCommandFixture(
        #"{"command":"type","commandId":"type-hardware-keyboard-submit","text":"\n"}"#
      )
    )

    XCTAssertTrue(submitResponse.ok, String(describing: submitResponse.error))
    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertEqual(submitResponse.data?.textEntryRoute, "synthesized-first-responder")
    XCTAssertNil(textEntryTapWitness, "the submit must consume the tap witness it was addressed by")
  }

  @MainActor
  func testBareSubmitKeyRefusesWhenPrivateSynthesisIsUnavailable() throws {
    let textField = try launchHardwareKeyboardFixture()
    try skipUnlessSoftwareKeyboardIsHidden()

    let failureCountBefore = currentXCTestFailureCount()
    let result = typeTextReliably(
      app: app,
      target: TextEntryTarget(
        element: textField,
        refreshPoint: nil,
        prefersFocusedElement: false,
        fromTapWitness: true
      ),
      text: "\n",
      delaySeconds: 0,
      synthesizer: UnavailableTextEntrySynthesizer()
    )

    XCTAssertEqual(result.failure, .synthesisUnavailable)
    XCTAssertEqual(result.textEntryRoute, "synthesized-first-responder")
    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
  }

  @MainActor
  func testBareDelayedTypeFailsWhenTappedInputDisappearsMidCommand() throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-disappear-after-input",
    ]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))

    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForExistence(timeout: appExistenceTimeout))
    let tapCommand = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-disappearing-input","selectorKey":"id","selectorValue":"agent-device-hardware-keyboard-input"}"#
    )
    let tapResponse = try executeOnMainPrepared(command: tapCommand, activeApp: app)
    XCTAssertTrue(tapResponse.ok, String(describing: tapResponse.error))

    let failureCountBefore = currentXCTestFailureCount()
    let typeCommand = try runnerCommandFixture(
      #"{"command":"type","commandId":"type-disappearing-input","text":"ab","delayMs":50,"textEntryMode":"append"}"#
    )
    let typeResponse = executeTypeCommand(activeApp: app, command: typeCommand)

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertFalse(typeResponse.ok)
    XCTAssertEqual(typeResponse.error?.code, "TEXT_INPUT_NOT_FOCUSED")
    XCTAssertFalse(textField.exists)
  }

  // An auto-submitting code field: the last digit navigates to a screen with its own input where the
  // code field was. Every character was delivered, so the fill succeeds unverified, without an
  // XCTest failure (XCTEST_RECORDED_FAILURE and a session restart), and without verifying or
  // repairing into the next screen's input.
  @MainActor
  func testFillSucceedsWhenAppReplacesInputAfterLastCharacter() throws {
    let textField = try launchRemovableInputFixture("--agent-device-text-entry-auto-submit")

    let failureCountBefore = currentXCTestFailureCount()
    let response = executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-auto-submit", text: "123456", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(response.data?.message, "typed")
    XCTAssertFalse(textField.exists)
    let nextScreenField = app.textFields["agent-device-auto-submit-next-screen-input"]
    XCTAssertTrue(nextScreenField.exists)
    XCTAssertEqual(editableTextValue(for: nextScreenField, treatingPlaceholderAsEmpty: true), "")
  }

  // The reported shape: the last digit navigates to a screen without an input.
  @MainActor
  func testFillSucceedsWhenAppRemovesInputAfterLastCharacter() throws {
    let textField = try launchRemovableInputFixture("--agent-device-text-entry-auto-submit-without-successor")

    let failureCountBefore = currentXCTestFailureCount()
    let response = executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-auto-submit-no-successor", text: "123456", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(response.data?.message, "typed")
    XCTAssertFalse(textField.exists)
    XCTAssertEqual(app.textFields.count, 0)
  }

  // The closest negative: the input is removed after the first character, so the rest was never
  // delivered. That stays a typed failure, still without an XCTest failure.
  @MainActor
  func testFillFailsWhenAppRemovesInputBeforeTextIsDelivered() throws {
    let textField = try launchRemovableInputFixture("--agent-device-text-entry-disappear-after-input")

    let failureCountBefore = currentXCTestFailureCount()
    let response = executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-disappearing-input", text: "123456", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_INPUT_NOT_FOCUSED")
    XCTAssertFalse(textField.exists)
  }

  // The navigation lands after the first character and focuses a successor input in the same spot.
  // The remaining posts resolve that successor by point, so they must refuse it rather than type the
  // rest of the code into the next screen.
  @MainActor
  func testFillFailsWhenAppReplacesInputBeforeTextIsDelivered() throws {
    let textField = try launchRemovableInputFixture("--agent-device-text-entry-replace-after-input")

    let failureCountBefore = currentXCTestFailureCount()
    let response = executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-replaced-input", text: "123456", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_INPUT_NOT_FOCUSED")
    XCTAssertFalse(textField.exists)
    let nextScreenField = app.textFields["agent-device-auto-submit-next-screen-input"]
    XCTAssertTrue(nextScreenField.exists)
    XCTAssertEqual(editableTextValue(for: nextScreenField, treatingPlaceholderAsEmpty: true), "")
  }

  // Neither input has an identifier, so the successor carries the same identity as the code field.
  // The runner cannot tell them apart and must not clear and retype the successor: it reports the
  // mismatch it read instead of repairing.
  @MainActor
  func testFillDoesNotRepairIntoAnIndistinguishableSuccessorInput() throws {
    let textField = try launchRemovableInputFixture(
      "--agent-device-text-entry-auto-submit",
      "--agent-device-text-entry-unnamed-input"
    )

    let failureCountBefore = currentXCTestFailureCount()
    let response = executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-unnamed-successor", text: "123456", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_ENTRY_MISMATCH")
    XCTAssertEqual(app.textFields.count, 1)
    XCTAssertEqual(editableTextValue(for: app.textFields.element(boundBy: 0), treatingPlaceholderAsEmpty: true), "")
  }

  // A one-time-code field whose value is a digit-count summary auto-submits on the last digit and a
  // named input takes its place. The bound field is gone, so the fill is the plain unverified
  // "typed": no unconfirmed evidence read off the successor, and no text in it.
  @MainActor
  func testFillIntoAutoSubmittingDigitCountFieldReportsNoEvidenceFromItsSuccessor() throws {
    let textField = try launchRemovableInputFixture(
      "--agent-device-text-entry-digit-count-value",
      "--agent-device-text-entry-auto-submit"
    )

    let failureCountBefore = currentXCTestFailureCount()
    let response = executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-digit-count-auto-submit", text: "123456", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(response.data?.message, "typed")
    XCTAssertNil(response.data?.verification)
    XCTAssertFalse(textField.exists)
    let nextScreenField = app.textFields["agent-device-auto-submit-next-screen-input"]
    XCTAssertTrue(nextScreenField.exists)
    XCTAssertEqual(editableTextValue(for: nextScreenField, treatingPlaceholderAsEmpty: true), "")
  }

  // Pins a known limit, not desired behavior: neither input has an identifier, and the successor
  // takes the code field's index in the query that bound it, so the remaining posts resolve to it
  // and land in the successor. Refusing point and focus re-resolution would not help, because the
  // index-bound query itself returns the successor. What must hold is a typed failure, never success
  // or a repair into the successor. The successor's "23456" records the wrong-target side effect; a
  // per-instance identity would make that assertion fail, and the test should then change with it.
  @MainActor
  func testFillPinsKnownLimitWhenAnIndistinguishableInputReplacesItMidDelivery() throws {
    let textField = try launchRemovableInputFixture(
      "--agent-device-text-entry-replace-after-input",
      "--agent-device-text-entry-unnamed-input"
    )

    let failureCountBefore = currentXCTestFailureCount()
    let response = executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-unnamed-replaced", text: "123456", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_ENTRY_MISMATCH")
    XCTAssertEqual(app.textFields.count, 1)
    XCTAssertEqual(editableTextValue(for: app.textFields.element(boundBy: 0), treatingPlaceholderAsEmpty: true), "23456")
  }

  // Text past the delivery budget cannot be paced into a field the runner cannot resolve, so it goes
  // through application-wide typing. The budget is charged the whole command, warmup split included:
  // an append peels its first character for warmup, so a per-dispatch charge would find both of its
  // pieces inside the budget and pace all these characters. The target carries no element by
  // construction, so nothing on that route can read the value back: the command reports it
  // unverified and this test reads the field itself to show every character arrived.
  @MainActor
  func testOverBudgetTypeWithoutResolvableElementTypesApplicationWide() throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-soft-keyboard",
    ]
    app.launch()
    addTeardownBlock { [self] in
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))

    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForExistence(timeout: appExistenceTimeout))
    let tapCommand = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-soft-keyboard-input","selectorKey":"id","selectorValue":"agent-device-hardware-keyboard-input"}"#
    )
    let tapResponse = try executeOnMainPrepared(command: tapCommand, activeApp: app)
    XCTAssertTrue(tapResponse.ok, String(describing: tapResponse.error))
    try skipUnlessSoftwareKeyboardIsVisible()

    // The shortest append the budget refuses. `maxTextLength` answers for a replacement, whose
    // clears cost more than an append's warmup split, so it names a shorter text than this one.
    var count = 1
    while !SynthesizedDeliveryBudget.exceeds(
      Self.synthesizedTextPlan(
        characterCount: count,
        delaySeconds: 0,
        selectsExistingText: false,
        peelsWarmupCharacter: true
      )
    ) {
      count += 1
    }
    let text = String(repeating: "x", count: count)
    let failureCountBefore = currentXCTestFailureCount()
    // The target the `type` command builds when it cannot resolve an input but the keyboard is up:
    // no element, no refresh point, focused-element preference.
    let result = typeTextReliably(
      app: app,
      target: TextEntryTarget(
        element: nil,
        refreshPoint: nil,
        prefersFocusedElement: true,
        fromTapWitness: true
      ),
      text: text,
      delaySeconds: 0,
      repairMode: .append,
      synthesizer: PrivateXCTestTextEntrySynthesizer()
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertNil(result.failure)
    XCTAssertEqual(result.textEntryRoute, "xctest-application-fallback")
    // This branch has no element to read, so the value arrives unverified and the command waited for
    // nothing. The field is polled here, under its own deadline.
    let valueDeadline = Date().addingTimeInterval(appExistenceTimeout)
    var observed: String?
    while Date() < valueDeadline {
      observed = textField.value as? String
      if observed == text { break }
      Thread.sleep(forTimeInterval: 0.25)
    }
    XCTAssertEqual(observed, text)
  }

  private struct UnavailableTextEntrySynthesizer: TextEntrySynthesizing {
    func enterText(
      app _: XCUIApplication,
      text _: String,
      replacingExistingText _: Bool
    ) -> SynthesizedTextEntryAction {
      .fallback
    }
  }

  private func launchHardwareKeyboardFixture() throws -> XCUIElement {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    addTeardownBlock { [self] in
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))
    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForExistence(timeout: appExistenceTimeout))
    XCTAssertFalse(textField.frame.isEmpty)
    return textField
  }

  /// Launches the soft-keyboard text-entry fixture with `arguments` choosing when the app removes or
  /// replaces its input, and returns that input bound by index, since it may have no identifier.
  private func launchRemovableInputFixture(_ arguments: String...) throws -> XCUIElement {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-soft-keyboard",
    ] + arguments
    app.launch()
    addTeardownBlock { [self] in
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForExistence(timeout: appExistenceTimeout))
    let textField = arguments.contains("--agent-device-text-entry-unnamed-input")
      ? app.textFields.element(boundBy: 0)
      : app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForExistence(timeout: appExistenceTimeout))
    return textField
  }

  /// The `type` command the daemon sends for `fill`: replace mode, addressed by the input's center.
  private func fillCommandFixture(commandId: String, text: String, at element: XCUIElement) throws -> Command {
    let frame = element.frame
    return try runnerCommandFixture(
      #"{"command":"type","commandId":"\#(commandId)","text":"\#(text)","textEntryMode":"replace","x":\#(frame.midX),"y":\#(frame.midY)}"#
    )
  }

  @MainActor
  private func tapHardwareKeyboardInput(commandId: String) throws {
    let tapCommand = try runnerCommandFixture(
      #"{"command":"tap","commandId":"\#(commandId)","selectorKey":"id","selectorValue":"agent-device-hardware-keyboard-input"}"#
    )
    let tapResponse = try executeOnMainPrepared(command: tapCommand, activeApp: app)
    XCTAssertTrue(tapResponse.ok, String(describing: tapResponse.error))
  }

  // A precondition, not a product claim. The fixture's empty `inputView` is what keeps the
  // keyboard down, but nothing in this bundle owns the simulator's own keyboard settings, so an
  // ambient keyboard here is an environment fact rather than a product regression.
  private func skipUnlessSoftwareKeyboardIsHidden() throws {
    try XCTSkipIf(
      isKeyboardVisible(app: app),
      "software keyboard is up: this simulator cannot exercise the hidden-keyboard responder path"
    )
  }

  // The mirror precondition. A simulator with a hardware keyboard attached can keep the software
  // keyboard down even for a field that has a real input view, which is an environment fact.
  private func skipUnlessSoftwareKeyboardIsVisible() throws {
    try XCTSkipIf(
      !isKeyboardVisible(app: app),
      "software keyboard is down: this simulator cannot exercise the keyboard-visible typing branch"
    )
  }
#endif
}
