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

  /// The emitted cadence line, as a pure function so its output is assertable. Only lengths and
  /// a timestamp are representable here; there is no String parameter, so observed field
  /// contents cannot reach runner.log through this boundary whatever they contain.
  static func commitCadenceLogLine(
    elapsedMs: Int,
    observedLen: Int,
    expectedPrefixLen: Int
  ) -> String {
    "[DEBUG-1874] poll t=\(elapsedMs)ms observedLen=\(observedLen) expectedPrefixLen=\(expectedPrefixLen)"
  }

  /// The typed boundary for commit-wait cadence evidence. The poll path must log through this
  /// function and never through a raw NSLog: every parameter is an Int, so the polled value's
  /// contents are unrepresentable at the call site.
  static func logCommitCadence(
    elapsedMs: Int,
    observedLen: Int,
    expectedPrefixLen: Int
  ) {
    NSLog(
      "%@",
      commitCadenceLogLine(
        elapsedMs: elapsedMs,
        observedLen: observedLen,
        expectedPrefixLen: expectedPrefixLen
      )
    )
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
    isExpired: () -> Bool,
    observe: () -> String?,
    waitForNextObservation: () -> Void
  ) -> SynthesizedTextCommitOutcome {
    if Self.textMatchesPlaceholder(expectedText, placeholder: placeholder) {
      return .notObserved
    }
    while true {
      if observe() == expectedText {
        return .settled
      }
      if isExpired() { return .notObserved }
      waitForNextObservation()
    }
  }

  /// The placeholder/deadline/observe/pacing ingredients shared by the append route
  /// (`awaitSynthesizedFirstResponderCommit`) and the replacement route
  /// (`awaitSynthesizedReplacementCommit`). What must NOT be shared is which outcome function
  /// consumes them: see `awaitSynthesizedReplacementCommitOutcome`'s doc comment for why append
  /// mode's "trust a diverged value" rule is wrong for replacement mode. Each caller therefore
  /// calls its own named outcome function directly, with real argument labels — deliberately not
  /// a stored closure/function-value parameter here, which would erase those labels at the call
  /// site and make the observe closure unrecognizable to the static content-redaction check in
  /// `apple-runner-log-redaction.test.ts` (`extractObserveClosure` locates the labeled closure
  /// literal by its text; a closure passed as a plain function value carries no such label).
  private func synthesizedCommitPollingIngredients(
    app: XCUIApplication,
    target: TextEntryTarget,
    expectedText: String
  ) -> (
    placeholder: String?,
    isExpired: () -> Bool,
    observe: () -> String?,
    waitForNextObservation: () -> Void
  ) {
    let placeholder = resolveTextEntryElement(app: app, target: target)?.placeholderValue
    let deadline = Date().addingTimeInterval(TextEntryTiming.synthesizedCommitTimeout)
    let waitStartedAt = Date()
    return (
      placeholder: placeholder,
      isExpired: { Date() >= deadline },
      observe: {
        let observedText = self.editableTextValue(
          for: self.resolveTextEntryElement(app: app, target: target),
          treatingPlaceholderAsEmpty: true
        )
        // Cadence evidence stays value-free: the polled value is user content typed through
        // `type`/`fill` and must never reach runner.log. Lengths and the expected-prefix walk
        // are enough to distinguish throttling (prefix grows slowly) from a wedge (it freezes).
        Self.logCommitCadence(
          elapsedMs: Int(waitStartedAt.timeIntervalSinceNow * -1000),
          observedLen: observedText?.count ?? -1,
          expectedPrefixLen: observedText.map { Self.commonPrefixLength($0, expectedText) } ?? -1
        )
        return observedText
      },
      // XCUI resolution shares the automation channel with the in-flight synthesized event.
      // Sparse reads let the target consume that event instead of continuously interrupting it.
      waitForNextObservation: { self.sleepFor(TextEntryTiming.synthesizedCommitPollInterval) }
    )
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
    let waitStartedAt = Date()
    NSLog("[DEBUG-1874] wait start expectedLen=%ld route=append", expectedText.count)
    let ingredients = synthesizedCommitPollingIngredients(app: app, target: target, expectedText: expectedText)
    let outcome = Self.awaitSynthesizedCommitOutcome(
      expectedText: expectedText,
      placeholder: ingredients.placeholder,
      isExpired: ingredients.isExpired,
      observe: ingredients.observe,
      waitForNextObservation: ingredients.waitForNextObservation
    )
    NSLog(
      "[DEBUG-1874] wait outcome=%@ elapsedMs=%.0f route=append",
      String(describing: outcome),
      waitStartedAt.timeIntervalSinceNow * -1000
    )
    return outcome
  }

  /// Blocks until the synthesized replacement text (`fill`) is observable in the target field, so
  /// `fill` cannot report ok while the select-all-and-retype it posted is still uncommitted — or
  /// silently wrong — on a slow or channel-penalized simulator (this route runs only when the
  /// XCTest channel is already penalized, and never resolves an `XCUIElement`, so it previously had
  /// no verification at all).
  ///
  /// Unlike the append route, the expected value is the final text itself — replacement mode
  /// clears the field first, so there is no `textBefore` prefix to account for — and unlike the
  /// append route, a settled mismatch is always reported rather than trusted: see
  /// `awaitSynthesizedReplacementCommitOutcome`'s doc comment.
  func awaitSynthesizedReplacementCommit(
    app: XCUIApplication,
    target: TextEntryTarget,
    expectedText: String
  ) -> SynthesizedTextCommitOutcome {
    guard !expectedText.contains("\n"), !expectedText.contains("\r") else {
      return .unobservable
    }
    let waitStartedAt = Date()
    NSLog("[DEBUG-1874] wait start expectedLen=%ld route=replacement", expectedText.count)
    let ingredients = synthesizedCommitPollingIngredients(app: app, target: target, expectedText: expectedText)
    let outcome = Self.awaitSynthesizedReplacementCommitOutcome(
      expectedText: expectedText,
      placeholder: ingredients.placeholder,
      isExpired: ingredients.isExpired,
      observe: ingredients.observe,
      waitForNextObservation: ingredients.waitForNextObservation
    )
    NSLog(
      "[DEBUG-1874] wait outcome=%@ elapsedMs=%.0f route=replacement",
      String(describing: outcome),
      waitStartedAt.timeIntervalSinceNow * -1000
    )
    return outcome
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
