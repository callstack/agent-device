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

  /// How the commit wait ended. Distinct from `SynthesizedTextCommitProgress`, which classifies a
  /// single observation: this is the whole wait's verdict, and it exists so the deadline can be
  /// told apart from success. The wait used to return `Void`, which made an expired deadline
  /// indistinguishable from a committed one — `type` then reported ok with a partial value in the
  /// field (#1874, #1844).
  enum SynthesizedTextCommitOutcome: Equatable {
    /// The app answered: the expected text committed, or the app transformed the input and the
    /// runner must not second-guess it.
    case settled
    /// There was nothing to wait for — no readable baseline, or the text carries a submit key.
    case unobservable
    /// The deadline expired with a strict prefix of the expected text still outstanding.
    case notObserved
  }

  /// The commit wait's decision, with observation, pacing and the clock injected so the deadline
  /// branch is exercisable without a simulator (the macOS host lane runs this; the member wrapper
  /// below binds the real XCUI reads).
  static func awaitSynthesizedCommitOutcome(
    expectedText: String,
    placeholder: String?,
    isExpired: () -> Bool,
    observe: () -> String?,
    waitForNextObservation: () -> Void
  ) -> SynthesizedTextCommitOutcome {
    // A placeholder-equal AX value cannot prove a commit: an input handler may clear even a
    // previously non-empty field after dispatch, making the empty field render the same value.
    // Refuse before polling because no later read can distinguish those states.
    if Self.textMatchesPlaceholder(expectedText, placeholder: placeholder) {
      return .notObserved
    }
    // The deadline is checked AFTER an observation, never before one, so the last thing that
    // happens before condemning a commit is a read. Checking first would condemn a commit that
    // landed during the final poll sleep — the exact loaded-host timing this wait exists for.
    while true {
      switch synthesizedTextCommitProgress(observedText: observe(), expectedText: expectedText) {
      case .committed, .diverged:
        return .settled
      case .pending:
        if isExpired() { return .notObserved }
        waitForNextObservation()
      }
    }
  }

  /// The command-level consequence of a commit wait. `.unobservable` is not a failure: there was
  /// no baseline to compare against, which is the pre-existing contract for submit-key text and
  /// unreadable fields, not evidence that anything went wrong.
  static func textEntryFailure(
    forCommitOutcome outcome: SynthesizedTextCommitOutcome
  ) -> TextEntryFailure? {
    switch outcome {
    case .settled, .unobservable:
      return nil
    case .notObserved:
      return .commitNotObserved
    }
  }

  /// Blocks until the synthesized bare-type text is observable in the target field, so `type`
  /// cannot report ok while trailing characters are still uncommitted on a slow simulator.
  ///
  /// Observation only. A stalled prefix cannot be told apart from a suffix still queued in the
  /// event stream, so re-synthesizing the difference risks committing it twice after the command
  /// already reported success (#1676 rejected exactly that repair). Reporting `.notObserved` is
  /// what the caller does instead: the partial value is the agent's to resolve, and a named
  /// failure beats a success that misdescribes the field. Text carrying a submit key is skipped
  /// outright: the app may clear or rewrite the field on submit, so `textBefore + typedText` is
  /// not the value to wait for.
  func awaitSynthesizedFirstResponderCommit(
    app: XCUIApplication,
    target: TextEntryTarget,
    textBefore: String?,
    typedText: String
  ) -> SynthesizedTextCommitOutcome {
    guard let textBefore, !typedText.contains("\n"), !typedText.contains("\r") else {
      return .unobservable
    }
    let expectedText = textBefore + typedText
    let placeholder = resolveTextEntryElement(app: app, target: target)?.placeholderValue
    let deadline = Date().addingTimeInterval(TextEntryTiming.synthesizedCommitTimeout)
    return Self.awaitSynthesizedCommitOutcome(
      expectedText: expectedText,
      placeholder: placeholder,
      isExpired: { Date() >= deadline },
      observe: {
        editableTextValue(
          for: resolveTextEntryElement(app: app, target: target),
          treatingPlaceholderAsEmpty: true
        )
      },
      // XCUI resolution shares the automation channel with the in-flight synthesized event.
      // Sparse reads let the target consume that event instead of continuously interrupting it.
      waitForNextObservation: { sleepFor(TextEntryTiming.synthesizedCommitPollInterval) }
    )
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
