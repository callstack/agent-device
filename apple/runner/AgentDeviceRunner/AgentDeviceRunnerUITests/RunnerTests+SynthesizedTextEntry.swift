import XCTest

// AX-independent text synthesis: private-XCTest boundary, pacing plan, and route policy.
// The verified XCUIElement path remains in TextEntry/TextTyping.
extension RunnerTests {
  enum SynthesizedReplacementRouteOutcome {
    case notApplicable
    case completed(TextEntryResult)
    case fallback(TextEntryTarget)
  }

  struct SynthesizedReplacementRequest {
    let app: XCUIApplication
    let target: TextEntryTarget
    let text: String
    let delaySeconds: Double
    let synthesizer: any TextEntrySynthesizing
    let commandId: String?
    let startedAt: Date
  }

  enum SynthesizedTextEntryAction: Equatable {
    case continueTyping
    case fallback
    case raise(String?)
  }

  protocol TextEntrySynthesizing {
    func enterText(
      app: XCUIApplication,
      text: String,
      replacingExistingText: Bool
    ) -> SynthesizedTextEntryAction
  }

  struct PrivateXCTestTextEntrySynthesizer: TextEntrySynthesizing {
    func enterText(
      app: XCUIApplication,
      text: String,
      replacingExistingText: Bool
    ) -> SynthesizedTextEntryAction {
#if os(iOS)
      let result = replacingExistingText
        ? RunnerSynthesizedTextEntry.replaceText(withApplication: app, text: text)
        : RunnerSynthesizedTextEntry.synthesizeText(withApplication: app, text: text)
      return Self.action(status: result.status, message: result.message)
#else
      return .fallback
#endif
    }

#if os(iOS)
    static func action(
      status: RunnerSynthesizedTextEntryStatus,
      message: String?
    ) -> SynthesizedTextEntryAction {
      switch status {
      case .succeeded:
        return .continueTyping
      case .unavailable:
        return .fallback
      case .failed:
        return .raise(message)
      @unknown default:
        return .raise(message)
      }
    }
#endif
  }

  struct SynthesizedReplacementStep: Equatable {
    let text: String
    let replacesExistingText: Bool
  }

  static func synthesizedReplacementSteps(
    text: String,
    delaySeconds: Double
  ) -> [SynthesizedReplacementStep] {
    let characters = Array(text)
    guard delaySeconds > 0, characters.count > 1 else {
      return [SynthesizedReplacementStep(text: text, replacesExistingText: true)]
    }
    return characters.enumerated().map { index, character in
      SynthesizedReplacementStep(
        text: String(character),
        replacesExistingText: index == 0
      )
    }
  }

  func runSynthesizedReplacementRoute(
    _ request: SynthesizedReplacementRequest
  ) -> SynthesizedReplacementRouteOutcome {
#if os(iOS)
    NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_ROUTE route=synthesized-first-responder-replacement")
    let steps = Self.synthesizedReplacementSteps(
      text: request.text,
      delaySeconds: request.delaySeconds
    )
    for (index, step) in steps.enumerated() {
      switch request.synthesizer.enterText(
        app: request.app,
        text: step.text,
        replacingExistingText: step.replacesExistingText
      ) {
      case .fallback:
        NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_ROUTE route=verified-fallback reason=synthesis-unavailable")
        guard let point = request.target.refreshPoint else { return .notApplicable }
        return .fallback(
          focusTextInputForTextEntry(app: request.app, x: point.x, y: point.y)
        )
      case .raise(let message):
        NSException(
          name: NSExceptionName.internalInconsistencyException,
          reason: message ?? "private XCTest text synthesis failed"
        ).raise()
      case .continueTyping:
        break
      }
      if index + 1 < steps.count {
        sleepFor(request.delaySeconds)
      }
    }
    logTextEntryPhase(
      commandId: request.commandId,
      phase: "total",
      startedAt: request.startedAt,
      chars: request.text.count,
      mode: .replacement
    )
    return .completed(
      TextEntryResult(
        verified: nil,
        repaired: false,
        expectedText: request.text,
        observedText: nil,
        textEntryRoute: "synthesized-first-responder-replacement"
      )
    )
#else
    return .notApplicable
#endif
  }

  static func shouldUseSynthesizedFirstResponderReplacement(
    hasResolvedElement: Bool,
    hasRefreshPoint: Bool,
    xCTestChannelPenalized: Bool
  ) -> Bool {
    !hasResolvedElement && hasRefreshPoint && xCTestChannelPenalized
  }

  static func shouldUseSynthesizedFirstResponderType(
    repairMode: TextTypingRepairMode,
    fromTapWitness: Bool,
    softwareKeyboardVisible: Bool
  ) -> Bool {
    repairMode == .none && fromTapWitness && !softwareKeyboardVisible
  }

  enum SynthesizedTextCommitProgress: Equatable {
    case committed
    case pending
    case diverged
  }

  // The private synthesize call returns once the event record is posted, not once the target
  // app has committed the characters, so intermediate reads walk prefix-by-prefix toward the
  // expected value. Anything off that prefix path means the app transformed the input
  // (formatter, mid-text caret, autocomplete) and the runner must not second-guess it. An
  // unreadable value — secure field, or the element stopped resolving — ends the wait the
  // same way.
  static func synthesizedTextCommitProgress(
    observedText: String?,
    expectedText: String
  ) -> SynthesizedTextCommitProgress {
    guard let observedText else {
      return .diverged
    }
    if observedText == expectedText {
      return .committed
    }
    return expectedText.hasPrefix(observedText) ? .pending : .diverged
  }

  /// Blocks until the synthesized bare-type text is observable in the target field, so `type`
  /// cannot report ok while trailing characters are still uncommitted on a slow simulator.
  ///
  /// Observation only. A stalled prefix cannot be told apart from a suffix still queued in the
  /// event stream, so re-synthesizing the difference risks committing it twice after the command
  /// already reported success. Text carrying a submit key is skipped outright: the app may clear
  /// or rewrite the field on submit, so `textBefore + typedText` is not the value to wait for.
  func awaitSynthesizedFirstResponderCommit(
    app: XCUIApplication,
    target: TextEntryTarget,
    textBefore: String?,
    typedText: String
  ) {
    guard let textBefore, !typedText.contains("\n"), !typedText.contains("\r") else {
      return
    }
    let expectedText = textBefore + typedText
    let deadline = Date().addingTimeInterval(TextEntryTiming.synthesizedCommitTimeout)
    while Date() < deadline {
      let observedText = editableTextValue(
        for: resolveTextEntryElement(app: app, target: target),
        treatingPlaceholderAsEmpty: true
      )
      switch Self.synthesizedTextCommitProgress(observedText: observedText, expectedText: expectedText) {
      case .committed, .diverged:
        return
      case .pending:
        sleepFor(TextEntryTiming.pollInterval)
      }
    }
  }

  static func shouldUseResolvedCoordinateTextEntryRoute(
    repairMode: TextTypingRepairMode,
    hasX: Bool,
    hasY: Bool,
    xCTestChannelPenalized: Bool
  ) -> Bool {
    repairMode == .replacement && hasX && hasY && xCTestChannelPenalized
  }

  static func shouldFallbackFromSynthesizedTextEntryFocus(
    _ outcome: RunnerInteractionOutcome
  ) -> Bool {
    if case .unsupported = outcome { return true }
    return false
  }
}
