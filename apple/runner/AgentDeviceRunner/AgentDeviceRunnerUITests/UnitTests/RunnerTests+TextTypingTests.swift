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

    let response = try executeTypeCommand(
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
    let typeResponse = try executeTypeCommand(
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
    let unfocusedResponse = try executeTypeCommand(
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
    let appendResponse = try executeTypeCommand(
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
    let submitResponse = try executeTypeCommand(
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
    let result = try typeTextReliably(
      app: app,
      target: TextEntryTarget(
        element: textField,
        refreshPoint: nil,
        prefersFocusedElement: false,
        contentTranslation: .none,
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
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))

    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForFixtureExistence(timeout: appExistenceTimeout))
    let tapCommand = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-disappearing-input","selectorKey":"id","selectorValue":"agent-device-hardware-keyboard-input"}"#
    )
    let tapResponse = try executeOnMainPrepared(command: tapCommand, activeApp: app)
    XCTAssertTrue(tapResponse.ok, String(describing: tapResponse.error))

    let failureCountBefore = currentXCTestFailureCount()
    let typeCommand = try runnerCommandFixture(
      #"{"command":"type","commandId":"type-disappearing-input","text":"ab","delayMs":50,"textEntryMode":"append"}"#
    )
    let typeResponse = try executeTypeCommand(activeApp: app, command: typeCommand)

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
    let response = try executeTypeCommand(
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

  // A value longer than one clear burst and wider than its field (#3851): the caret edge-tap lands
  // mid-text and a burst deletes at most 120 characters, so neither alone can reach all of it.
  @MainActor
  func testFillReplacesAValueLongerThanOneClearBurst() throws {
    let textField = try launchRemovableInputFixture("--agent-device-text-entry-long-prefill")

    let response = try executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-long-prefill", text: "Ada Lovelace", at: textField)
    )

    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(response.data?.textEntryRoute, "xctest-element")
    XCTAssertEqual(editableTextValue(for: textField), "Ada Lovelace")
  }

  @MainActor
  func testFillClearsAValueLongerThanOneClearBurst() throws {
    let textField = try launchRemovableInputFixture("--agent-device-text-entry-long-prefill")

    let response = try executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "clear-long-prefill", text: "", at: textField)
    )

    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(editableTextValue(for: textField, treatingPlaceholderAsEmpty: true), "")
  }

  // The clear's first delete navigates to a screen whose input, already holding a value, takes the
  // cleared one's place under the same handle. The clear keeps going only on the input it started on.
  @MainActor
  func testFillClearDoesNotEraseTheInputThatReplacedItsTarget() throws {
    let textField = try launchRemovableInputFixture(
      "--agent-device-text-entry-long-prefill",
      "--agent-device-text-entry-populated-successor"
    )

    let failureCountBefore = currentXCTestFailureCount()
    _ = try executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-clear-replaced-input", text: "", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertFalse(textField.exists)
    let nextScreenField = app.textFields["agent-device-auto-submit-next-screen-input"]
    XCTAssertTrue(nextScreenField.exists)
    XCTAssertEqual(editableTextValue(for: nextScreenField), "next screen value")
  }

  // The reported shape: the last digit navigates to a screen without an input.
  @MainActor
  func testFillSucceedsWhenAppRemovesInputAfterLastCharacter() throws {
    let textField = try launchRemovableInputFixture("--agent-device-text-entry-auto-submit-without-successor")

    let failureCountBefore = currentXCTestFailureCount()
    let response = try executeTypeCommand(
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
    let response = try executeTypeCommand(
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
    let response = try executeTypeCommand(
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

  @MainActor
  func testFillFailsWhenAppRemovesMaskedInputBeforeTextIsDelivered() throws {
    let textField = try launchRemovableInputFixture(
      "--agent-device-text-entry-masked-value",
      "--agent-device-text-entry-disappear-after-input"
    )

    let failureCountBefore = currentXCTestFailureCount()
    let response = try executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-disappearing-masked-input", text: "123456", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_INPUT_NOT_FOCUSED")
    XCTAssertFalse(textField.exists)
    XCTAssertEqual(app.textFields.count, 0)
  }

  @MainActor
  func testFillFailsWhenAppReplacesMaskedInputBeforeTextIsDelivered() throws {
    let textField = try launchRemovableInputFixture(
      "--agent-device-text-entry-masked-value",
      "--agent-device-text-entry-replace-after-input"
    )

    let failureCountBefore = currentXCTestFailureCount()
    let response = try executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-replaced-masked-input", text: "123456", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_INPUT_NOT_FOCUSED")
    XCTAssertFalse(textField.exists)
    let nextScreenField = app.textFields["agent-device-auto-submit-next-screen-input"]
    XCTAssertTrue(nextScreenField.exists)
    XCTAssertEqual(editableTextValue(for: nextScreenField, treatingPlaceholderAsEmpty: true), "")
  }

  // The navigation lands while the fill pauses after reading its first masked character back, which
  // it does because a masked value cannot show whether the character arrived. The read before the
  // pause named the code field, so the next post must resolve the field again and refuse the
  // successor rather than type the rest of the code into it.
  @MainActor
  func testFillFailsWhenAppReplacesMaskedInputWhileWarmupPauses() throws {
    let textField = try launchRemovableInputFixture(
      "--agent-device-text-entry-masked-value",
      "--agent-device-text-entry-replace-on-request"
    )
    let replace = app.buttons["agent-device-text-entry-replace"]
    XCTAssertTrue(replace.exists)
    var replacements = 0
    textEntryWarmupPauseForTesting = {
      guard replacements == 0 else { return }
      replacements += 1
      replace.tap()
    }
    defer { textEntryWarmupPauseForTesting = nil }

    let failureCountBefore = currentXCTestFailureCount()
    let response = try executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-masked-replaced-in-pause", text: "123456", at: textField)
    )

    XCTAssertEqual(replacements, 1)
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
    let response = try executeTypeCommand(
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
    let response = try executeTypeCommand(
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

  // An unidentified field that moves once the first character arrives, the way an iOS 26 bottom
  // search bar rises above the keyboard: the read-back finds it, still focused, at another frame
  // than the pre-entry read, holding exactly the requested text.
  @MainActor
  func testFillVerifiesAnUnidentifiedFieldThatMovesWhileTyping() throws {
    let textField = try launchRemovableInputFixture(
      "--agent-device-text-entry-moves-on-input",
      "--agent-device-text-entry-unnamed-input"
    )
    let frameBefore = textField.frame

    let failureCountBefore = currentXCTestFailureCount()
    let response = try executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-moves-on-input", text: "hello", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(response.data?.message, "typed")
    XCTAssertNotEqual(textField.frame, frameBefore)
    XCTAssertEqual(editableTextValue(for: textField, treatingPlaceholderAsEmpty: true), "hello")
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
    let response = try executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-unnamed-replaced", text: "123456", at: textField)
    )

    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "TEXT_ENTRY_MISMATCH")
    // A sensitive fill's value must not come back, and the observed text is an altered form of it.
    XCTAssertEqual(response.error?.message, "text entry read-back did not match the requested text")
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
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))

    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForFixtureExistence(timeout: appExistenceTimeout))
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
    let result = try typeTextReliably(
      app: app,
      target: TextEntryTarget(
        element: nil,
        refreshPoint: nil,
        prefersFocusedElement: true,
        contentTranslation: .none,
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

  // A React Native `secureTextEntry` field is a `.textField` whose value reads back as bullets, so
  // the typed text can never match it. The fill must report typed and unverified instead of a
  // mismatch, and must not run the repair, whose clear taps the field's right edge where a
  // show/hide toggle commonly sits (tester-army/e2e#872).
  @MainActor
  func testFillIntoMaskedTextFieldIsUnverifiedRatherThanAMismatch() throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-masked-value",
    ]
    app.launch()
    addTeardownBlock { [self] in
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForFixtureExistence(timeout: appExistenceTimeout))
    let togglePresses = app.staticTexts["agent-device-masked-toggle-presses"]
    XCTAssertTrue(togglePresses.waitForFixtureExistence(timeout: appExistenceTimeout))
    XCTAssertEqual(togglePresses.label, "presses=0")
    try tapHardwareKeyboardInput(commandId: "tap-masked-input")

    let failureCountBefore = currentXCTestFailureCount()
    let fillResponse = try executeTypeCommand(
      activeApp: app,
      command: try runnerCommandFixture(
        #"{"command":"type","commandId":"fill-masked-input","text":"not-a-secret-123","textEntryMode":"replace"}"#
      )
    )

    XCTAssertTrue(fillResponse.ok, String(describing: fillResponse.error))
    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    XCTAssertEqual(fillResponse.data?.message, "typed")
    let delivered = app.staticTexts["agent-device-masked-delivery"]
    let delivery = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "delivered"), object: delivered)
    XCTAssertEqual(XCTWaiter.wait(for: [delivery], timeout: appExistenceTimeout), .completed)
    XCTAssertEqual(togglePresses.label, "presses=0")
  }

  // A masked value cannot aim the clear's caret tap, which lands on a show/hide toggle at the field's
  // right edge; in React Native the press swaps the input and the fill fails (tester-army/e2e#1631).
  // The fixture's masked field shows one bullet per two characters, so 8 bullets is the new text alone.
  @MainActor
  func testFillReplacesAPrefilledMaskedValueWithoutPressingItsEdgeToggle() throws {
    try assertFillLeavesTheEdgeToggleUnpressed(
      launchArguments: ["--agent-device-text-entry-masked-value", "--agent-device-text-entry-prefilled"],
      field: { $0.textFields },
      expectedValue: String(repeating: "\u{2022}", count: 8)
    )
  }

  @MainActor
  func testFillReplacesAPrefilledSecureFieldWithoutPressingItsEdgeToggle() throws {
    try assertFillLeavesTheEdgeToggleUnpressed(
      launchArguments: ["--agent-device-text-entry-secure-entry", "--agent-device-text-entry-prefilled"],
      field: { $0.secureTextFields },
      expectedValue: String(repeating: "\u{2022}", count: 16)
    )
  }

  // An empty secure field with no placeholder shows nothing, so nothing is cleared.
  @MainActor
  func testFirstFillIntoAnEmptySecureFieldSkipsTheClear() throws {
    try assertFillLeavesTheEdgeToggleUnpressed(
      launchArguments: ["--agent-device-text-entry-secure-entry"],
      field: { $0.secureTextFields },
      expectedValue: String(repeating: "\u{2022}", count: 16)
    )
    XCTAssertEqual(try secureEntryCounts().deletes, 0)
  }

  // A field that refuses the focus tap reaches the clear without focus, and deletes sent to it record
  // an XCTest failure. The clear focuses it at its center first.
  @MainActor
  func testFillReplacesTextInASecureFieldThatRefusedTheFocusTap() throws {
    try assertFillLeavesTheEdgeToggleUnpressed(
      launchArguments: [
        "--agent-device-text-entry-secure-entry",
        "--agent-device-text-entry-prefilled",
        "--agent-device-text-entry-refuses-first-focus",
      ],
      field: { $0.secureTextFields },
      expectedValue: String(repeating: "\u{2022}", count: 16)
    )
  }

  // An empty one needs no clear, but the text typed next needs focus just as the deletes do.
  @MainActor
  func testFirstFillIntoAnEmptySecureFieldThatRefusedTheFocusTap() throws {
    try assertFillLeavesTheEdgeToggleUnpressed(
      launchArguments: ["--agent-device-text-entry-secure-entry", "--agent-device-text-entry-refuses-first-focus"],
      field: { $0.secureTextFields },
      expectedValue: String(repeating: "\u{2022}", count: 16)
    )
    XCTAssertEqual(try secureEntryCounts().deletes, 0)
  }

  // Deletes from a caret moved to the start reach none of the text, so the clear falls back to the caret
  // tap at the right edge, which in this fixture lands on the toggle: the limit `fill`'s docs name.
  @MainActor
  func testMaskedTextTheDeletesCannotReachFallsBackToTheCaretTap() throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-soft-keyboard",
      "--agent-device-text-entry-masked-value",
      "--agent-device-text-entry-prefilled",
    ]
    app.launch()
    addTeardownBlock { [self] in
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let input = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(input.waitForFixtureExistence(timeout: appExistenceTimeout))
    let togglePresses = app.staticTexts["agent-device-masked-toggle-presses"]
    XCTAssertTrue(togglePresses.waitForFixtureExistence(timeout: appExistenceTimeout))
    input.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).tap()

    let response = try executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-caret-at-start", text: "abc", at: input)
    )

    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(togglePresses.label, "presses=1")
  }

  // The issue's own case: its placeholder is eight bullets, which React Native reports as the value of
  // the empty field.
  @MainActor
  func testFirstFillIntoASecureFieldShowingABulletPlaceholderDoesNotPressItsEdgeToggle() throws {
    try assertFillLeavesTheEdgeToggleUnpressed(
      launchArguments: ["--agent-device-text-entry-secure-entry", "--agent-device-text-entry-bullet-placeholder"],
      field: { $0.secureTextFields },
      expectedValue: String(repeating: "\u{2022}", count: 16)
    )
  }

  // A plain masked field whose eight bullets match its eight-bullet placeholder can't be told from empty
  // either, so the refill still clears it. The fixture shows one bullet per two characters, so the 18
  // characters refilled show as 9 bullets, and kept stale text would show as 17.
  @MainActor
  func testRefillOfAMaskedFieldClearsTextThatReadsLikeItsBulletPlaceholder() throws {
    try assertFillLeavesTheEdgeToggleUnpressed(
      launchArguments: ["--agent-device-text-entry-masked-value", "--agent-device-text-entry-bullet-placeholder"],
      field: { $0.textFields },
      text: "not-a-secret-12345",
      expectedValue: String(repeating: "\u{2022}", count: 9),
      afterFilling: "abcdefghijklmnop"
    )
  }

  // iOS doesn't clear a field that kept its focus on its next edit, and eight characters read the same
  // as the eight-bullet placeholder, so the refill must still clear them. It reads the field's focus,
  // so it adds no tap to the first fill's one.
  @MainActor
  func testRefillOfAFocusedSecureFieldClearsTextThatReadsLikeItsBulletPlaceholder() throws {
    try assertFillLeavesTheEdgeToggleUnpressed(
      launchArguments: ["--agent-device-text-entry-secure-entry", "--agent-device-text-entry-bullet-placeholder"],
      field: { $0.secureTextFields },
      expectedValue: String(repeating: "\u{2022}", count: 16),
      afterFilling: "stale-pw"
    )
    XCTAssertEqual(try secureEntryCounts().taps, 1)
  }

  /// Fills `text` the way the daemon sends `fill`, after `earlierText` when given, and checks the field
  /// holds the new text alone while the toggle over its right edge stays unpressed.
  @MainActor
  private func assertFillLeavesTheEdgeToggleUnpressed(
    launchArguments: [String],
    field: (XCUIApplication) -> XCUIElementQuery,
    text: String = "not-a-secret-123",
    expectedValue: String,
    afterFilling earlierText: String? = nil
  ) throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-soft-keyboard",
    ] + launchArguments
    app.launch()
    addTeardownBlock { [self] in
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let input = field(app)["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(input.waitForFixtureExistence(timeout: appExistenceTimeout))
    let togglePresses = app.staticTexts["agent-device-masked-toggle-presses"]
    XCTAssertTrue(togglePresses.waitForFixtureExistence(timeout: appExistenceTimeout))
    XCTAssertEqual(togglePresses.label, "presses=0")
    if let earlierText {
      // Only the field this fill leaves is the precondition: a result that shows as a bullet placeholder
      // reads back as that placeholder, which fill's own check reports as a mismatch. An empty field
      // shows that placeholder too, so the app's length witness tells the two apart.
      _ = try executeTypeCommand(
        activeApp: app,
        command: try fillCommandFixture(commandId: "fill-earlier-text", text: earlierText, at: input)
      )
      let length = app.staticTexts["agent-device-masked-text-length"]
      let filled = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "label == %@", "length=\(earlierText.count)"),
        object: length
      )
      XCTAssertEqual(XCTWaiter.wait(for: [filled], timeout: appExistenceTimeout), .completed, length.label)
    }

    let failureCountBefore = currentXCTestFailureCount()
    let response = try executeTypeCommand(
      activeApp: app,
      command: try fillCommandFixture(commandId: "fill-masked-input-beside-toggle", text: text, at: input)
    )

    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertFalse(didRecordXCTestFailure(since: failureCountBefore))
    let replaced = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", expectedValue), object: input)
    XCTAssertEqual(XCTWaiter.wait(for: [replaced], timeout: appExistenceTimeout), .completed, String(describing: input.value))
    XCTAssertEqual(togglePresses.label, "presses=0")
  }

  /// The deletes and taps the secure entry fixture's field received.
  @MainActor
  private func secureEntryCounts() throws -> (deletes: Int, taps: Int) {
    let label = app.staticTexts["agent-device-secure-entry-counts"].label
    let counts = try label.split(separator: " ").map { try XCTUnwrap(Int($0.split(separator: "=").last ?? ""), label) }
    XCTAssertEqual(counts.count, 2, label)
    return (counts.first ?? -1, counts.last ?? -1)
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
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForFixtureExistence(timeout: appExistenceTimeout))
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
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let textField = arguments.contains("--agent-device-text-entry-unnamed-input")
      ? app.textFields.element(boundBy: 0)
      : app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForFixtureExistence(timeout: appExistenceTimeout))
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
