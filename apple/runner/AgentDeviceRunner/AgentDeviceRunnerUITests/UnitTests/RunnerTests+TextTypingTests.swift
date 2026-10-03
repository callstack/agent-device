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

    let text = String(
      repeating: "x",
      count: SynthesizedDeliveryBudget.maxTextLength(delaySeconds: 0) + 1
    )
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
