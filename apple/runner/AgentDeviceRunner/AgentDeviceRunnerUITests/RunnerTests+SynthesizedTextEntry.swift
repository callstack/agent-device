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
    // The private synthesize call returns at post time, not commit time (same as bare `type`,
    // see awaitSynthesizedFirstResponderCommit) — but this route never resolves an XCUIElement,
    // so without this wait it had no way to notice a dropped or still-in-flight character at all
    // and reported ok purely because the event posted. Wait here, on the same request.target
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

  /// How the commit wait ended. Distinct from `SynthesizedTextCommitProgress`, which classifies a
  /// single observation: this is the whole wait's verdict, and it exists so the deadline can be
  /// told apart from success. The wait used to return `Void`, which made an expired deadline
  /// indistinguishable from a committed one — `type` then reported ok with a partial value in the
  /// field (#1874, #1844).
  enum SynthesizedTextCommitOutcome: Equatable {
    /// The wait's success case, but its meaning is route-specific: for append mode (bare `type`),
    /// the expected text committed OR the app transformed the input in a way the runner must not
    /// second-guess; for replacement mode (`fill`), it means only an exact match — see
    /// `awaitSynthesizedReplacementCommitOutcome`'s doc comment for why replacement mode has no
    /// "trust it" case.
    case settled
    /// There was nothing to wait for — no readable baseline, or the text carries a submit key.
    case unobservable
    /// The deadline expired with the expected text still not observed.
    case notObserved
  }

  /// The commit wait's decision, with observation, pacing and the clock injected so both deadline
  /// branches are exercisable without a simulator (the macOS host lane runs this; the member
  /// wrapper below binds the real XCUI reads).
  ///
  /// The deadline is a local `var`, started from this loop's own first `now()` and advanced from
  /// the same observation the progress check reads, so "did the burst move" and "is time up" are
  /// two statements in one loop. The budget defaults to the shipped one, so only a test that is
  /// asking about time has to name it.
  static func awaitSynthesizedCommitOutcome(
    expectedText: String,
    placeholder: String?,
    stallBudget: TimeInterval = TextEntryTiming.synthesizedCommitStallTimeout,
    ceiling: TimeInterval = TextEntryTiming.synthesizedCommitCeiling,
    now: () -> Date = { Date() },
    observe: () -> String?,
    waitForNextObservation: () -> Void
  ) -> SynthesizedTextCommitOutcome {
    // A placeholder-equal AX value cannot prove a commit: an input handler may clear even a
    // previously non-empty field after dispatch, making the empty field render the same value.
    // Refuse before polling because no later read can distinguish those states.
    if Self.textMatchesPlaceholder(expectedText, placeholder: placeholder) {
      return .notObserved
    }
    var deadline = SynthesizedCommitDeadline(startedAt: now(), stallBudget: stallBudget, ceiling: ceiling)
    // The deadline is checked AFTER an observation, never before one, so the last thing that
    // happens before condemning a commit is a read. Checking first would condemn a commit that
    // landed during the final poll sleep — the exact loaded-host timing this wait exists for.
    while true {
      let observedText = observe()
      switch synthesizedTextCommitProgress(observedText: observedText, expectedText: expectedText) {
      case .committed, .diverged:
        return .settled
      case .pending:
        // One clock sample, so the instant an observation is recorded at is the instant it is
        // judged against.
        let sampledAt = now()
        deadline.record(
          expectedPrefixLength: Self.commonPrefixLength(observedText ?? "", expectedText),
          at: sampledAt
        )
        if deadline.isExpired(at: sampledAt) { return .notObserved }
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

  /// The replacement-mode counterpart of `awaitSynthesizedCommitOutcome`. It must NOT reuse that
  /// function's `synthesizedTextCommitProgress`: prefix-walk's `.diverged` case exists to trust an
  /// app that transforms bare-`type` input (formatter, autocomplete) rather than second-guess it —
  /// but that same rule silently accepts a dropped-character corruption too, because a value with a
  /// hole in the middle ("ada@example" -> "aexample") is neither a matching prefix NOR the full
  /// string, yet still gets classified `.diverged` -> `.settled` -> reported `ok: true`. This is not
  /// a hypothetical: it is the exact shape of the corruption this wait exists to catch (`fill`
  /// reporting success over "Avelace"/"aexample"-style drops), verified against both live examples
  /// before writing this comment.
  ///
  /// `.replacement` mode does not need prefix tolerance for legitimate transforms either:
  /// `isRepairableTextEntryMismatch` (RunnerTests+TextTyping.swift) already treats every mismatch in
  /// `.replacement` mode as repairable unconditionally, with no formatter/autocomplete carve-out —
  /// `fill` fully owns the field via select-all, so there is no legitimate reason for the settled
  /// value to be anything other than exactly what was requested. A settled non-match is therefore
  /// always the wait's failure case, never a `.settled` pass-through.
  static func awaitSynthesizedReplacementCommitOutcome(
    expectedText: String,
    placeholder: String?,
    stallBudget: TimeInterval = TextEntryTiming.synthesizedCommitStallTimeout,
    ceiling: TimeInterval = TextEntryTiming.synthesizedCommitCeiling,
    now: () -> Date = { Date() },
    observe: () -> String?,
    waitForNextObservation: () -> Void
  ) -> SynthesizedTextCommitOutcome {
    if Self.textMatchesPlaceholder(expectedText, placeholder: placeholder) {
      return .notObserved
    }
    var deadline = SynthesizedCommitDeadline(startedAt: now(), stallBudget: stallBudget, ceiling: ceiling)
    while true {
      let observedText = observe()
      if observedText == expectedText {
        return .settled
      }
      // Prefix growth cannot settle this wait — a value with a hole in the middle is still a
      // failure, see the doc comment above — but it is the same evidence that the burst is still
      // landing, so it buys the same time here as it does in append mode.
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

  static func shouldFallbackFromSynthesizedTextEntryFocus(
    _ outcome: RunnerInteractionOutcome
  ) -> Bool {
    if case .unsupported = outcome { return true }
    return false
  }
}
