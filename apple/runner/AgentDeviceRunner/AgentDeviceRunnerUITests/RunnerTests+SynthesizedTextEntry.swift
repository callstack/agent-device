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
      let postStartedAt = Date()
      let result = replacingExistingText
        ? RunnerSynthesizedTextEntry.replaceText(withApplication: app, text: text)
        : RunnerSynthesizedTextEntry.synthesizeText(withApplication: app, text: text)
      NSLog(
        "[DEBUG-1874] synthesize posted %d chars status=%d tookMs=%.0f",
        text.count, result.status.rawValue, postStartedAt.timeIntervalSinceNow * -1000
      )
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
    guard synthesizedReplacementIsSpaced(characterCount: text.count, delaySeconds: delaySeconds)
    else {
      return [SynthesizedReplacementStep(text: text, replacesExistingText: true)]
    }
    return Array(text).enumerated().map { index, character in
      SynthesizedReplacementStep(
        text: String(character),
        replacesExistingText: index == 0
      )
    }
  }

  /// Whether a replacement is posted one character per synthesize call, `delaySeconds` apart,
  /// rather than as one burst.
  static func synthesizedReplacementIsSpaced(characterCount: Int, delaySeconds: Double) -> Bool {
    delaySeconds > 0 && characterCount > 1
  }

  /// What a synthesized burst costs in wall clock, and the ceiling it has to fit inside before the
  /// first character is posted. `synthesizedReplacementSteps` decides how a text is posted; this
  /// decides whether the runner may start posting it at all.
  enum SynthesizedDeliveryBudget {
    /// Seconds between two characters of one synthesized burst.
    static var characterInterval: TimeInterval {
      1.0 / Double(RunnerSynthesizedTextEntry.typingSpeedCharactersPerSecond())
    }

    /// Seconds the plan spends posting: each synthesize call types its characters at the pace and
    /// pays its overhead, a spaced plan sleeps `delaySeconds` between two calls, and a plan that
    /// peels one character as a warmup (`typeWarmup`) pays one more call and the wait before the
    /// rest is posted. That wait is one poll here because the caller that asks has no element to
    /// read the warmup character back from, so `waitForWarmupValue` has no value to wait for.
    static func projectedSeconds(
      textLength: Int,
      delaySeconds: TimeInterval,
      typeWarmup: Bool = false
    ) -> TimeInterval {
      let spaced = synthesizedReplacementIsSpaced(characterCount: textLength, delaySeconds: delaySeconds)
      let warmupSplit = typeWarmup && textLength > 1 && !spaced
      let calls = spaced ? textLength : (warmupSplit ? 2 : 1)
      return Double(textLength) * characterInterval
        + Double(calls) * TextEntryTiming.synthesizeCallOverhead
        + Double(calls - 1) * delaySeconds
        + (warmupSplit ? TextEntryTiming.pollInterval : 0)
    }

    static func exceeds(
      textLength: Int,
      delaySeconds: TimeInterval,
      typeWarmup: Bool = false
    ) -> Bool {
      projectedSeconds(textLength: textLength, delaySeconds: delaySeconds, typeWarmup: typeWarmup)
        > TextEntryTiming.synthesizedDeliveryCeiling
    }

    /// Longest text `exceeds` admits at `delaySeconds`, which is what the refusal tells the caller.
    static func maxTextLength(delaySeconds: TimeInterval) -> Int {
      var length = 1
      while !exceeds(textLength: length + 1, delaySeconds: delaySeconds) {
        length += 1
      }
      return length
    }
  }

  func runSynthesizedReplacementRoute(
    _ request: SynthesizedReplacementRequest
  ) -> SynthesizedReplacementRouteOutcome {
#if os(iOS)
    NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_ROUTE route=synthesized-first-responder-replacement")
    if SynthesizedDeliveryBudget.exceeds(
      textLength: request.text.count,
      delaySeconds: request.delaySeconds
    ) {
      NSLog(
        "AGENT_DEVICE_RUNNER_TEXT_ENTRY_ROUTE route=synthesized-first-responder-replacement "
          + "reason=delivery-budget-refused chars=%d budgetChars=%d",
        request.text.count,
        SynthesizedDeliveryBudget.maxTextLength(delaySeconds: request.delaySeconds)
      )
      return .completed(
        TextEntryResult(
          verified: nil,
          repaired: false,
          expectedText: request.text,
          observedText: nil,
          textEntryRoute: "synthesized-first-responder-replacement",
          failure: .synthesisBudgetExceeded
        )
      )
    }
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
    // The private synthesize call returns at post time, not commit time, and this route never
    // resolves an XCUIElement, so without this wait it had no way to notice a dropped or
    // still-in-flight character at all. Wait here, on the same request.target
    // (element nil, refreshPoint set) that gated this route, so each poll re-resolves via the
    // refresh point rather than trusting a stale element handle.
    let commit = awaitSynthesizedReplacementCommit(
      app: request.app,
      target: request.target,
      expectedText: request.text
    )
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
        textEntryRoute: "synthesized-first-responder-replacement",
        failure: Self.textEntryFailure(forCommitOutcome: commit)
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

  /// The tap-witness route carries only the bare submit key, the one text the daemon sends without
  /// a text-entry mode. Ordinary `type` text arrives in `.append` mode and is typed through the
  /// resolved XCUIElement, where it is verified.
  static func shouldUseSynthesizedFirstResponderType(
    repairMode: TextTypingRepairMode,
    text: String,
    fromTapWitness: Bool,
    softwareKeyboardVisible: Bool
  ) -> Bool {
    repairMode == .none && text == "\n" && fromTapWitness && !softwareKeyboardVisible
  }

  /// Length of the shared prefix of two strings. Feeds value-free commit-wait logging: the
  /// expected-prefix walk over time distinguishes throttled delivery (grows slowly) from a
  /// wedged pipeline (freezes) without ever logging the field's contents.
  static func commonPrefixLength(_ lhs: String, _ rhs: String) -> Int {
    var length = 0
    for (l, r) in zip(lhs, rhs) {
      if l != r { break }
      length += 1
    }
    return length
  }

  /// How the commit wait ended: the whole wait's verdict, so the deadline can be told apart from
  /// success.
  enum SynthesizedTextCommitOutcome: Equatable {
    /// The field holds exactly the expected text.
    case settled
    /// There was nothing to wait for: the text carries a submit key.
    case unobservable
    /// The deadline expired with the expected text still not observed.
    case notObserved
  }

  /// The command-level consequence of a commit wait. `.unobservable` is not a failure: the app
  /// may clear or rewrite the field on submit, so there is no value to compare against.
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

  /// The replacement commit wait's decision, with observation, pacing and the clock injected so
  /// both deadline branches are exercisable without a simulator (the macOS host lane runs this;
  /// `awaitSynthesizedReplacementCommit` binds the real XCUI reads). The budget defaults to the
  /// shipped one, so only a test that is asking about time has to name it.
  ///
  /// Only an exact match settles. A value with a hole in the middle ("ada@example" -> "aexample")
  /// is the corruption this wait exists to catch, and `.replacement` mode has no formatter or
  /// autocomplete carve-out: `isRepairableTextEntryMismatch` (RunnerTests+TextTyping.swift) treats
  /// every `.replacement` mismatch as repairable, because `fill` owns the whole field via
  /// select-all. A settled non-match is therefore always the wait's failure case.
  static func awaitSynthesizedReplacementCommitOutcome(
    expectedText: String,
    placeholder: String?,
    stallBudget: TimeInterval = TextEntryTiming.synthesizedCommitStallTimeout,
    ceiling: TimeInterval = TextEntryTiming.synthesizedCommitCeiling,
    now: () -> Date = { Date() },
    observe: () -> String?,
    waitForNextObservation: () -> Void
  ) -> SynthesizedTextCommitOutcome {
    // A placeholder-equal AX value cannot prove a commit: an input handler may clear the field
    // after dispatch, making the empty field render the same value. Refuse before polling because
    // no later read can distinguish those states.
    if Self.textMatchesPlaceholder(expectedText, placeholder: placeholder) {
      return .notObserved
    }
    var deadline = SynthesizedCommitDeadline(startedAt: now(), stallBudget: stallBudget, ceiling: ceiling)
    // The deadline is checked AFTER an observation, never before one, so the last thing that
    // happens before condemning a commit is a read. Checking first would condemn a commit that
    // landed during the final poll sleep — the exact loaded-host timing this wait exists for.
    while true {
      let observedText = observe()
      if observedText == expectedText {
        return .settled
      }
      // Prefix growth cannot settle this wait, but it is evidence that the burst is still
      // landing, so it buys time. One clock sample, so the instant an observation is recorded at
      // is the instant it is judged against.
      let sampledAt = now()
      deadline.record(
        expectedPrefixLength: Self.commonPrefixLength(observedText ?? "", expectedText),
        at: sampledAt
      )
      if deadline.isExpired(at: sampledAt) { return .notObserved }
      waitForNextObservation()
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
}
