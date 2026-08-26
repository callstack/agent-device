import XCTest

// The synthesized text-entry commit wait, end to end: the deadline that bounds it, the two waits
// that run it, the observation/pacing they poll through, and the value-free cadence line that path
// is allowed to log. Split from RunnerTests+SynthesizedTextEntry.swift, which keeps the
// private-XCTest synthesis boundary and the route policies; the pure outcome functions these wrap
// stay there next to the rules they encode. Everything that touches the polled field value now
// lives in this one file, which is the surface apple-runner-log-redaction.test.ts guards.
extension RunnerTests {
  /// One commit wait's running deadline.
  ///
  /// A synthesized burst can be *throttled* rather than dropped: on a loaded simulator the
  /// characters keep landing, just slowly, and everything touching the input system slows with
  /// them (#1874). A flat wall-clock budget cannot tell that apart from a wedged pipeline, so it
  /// condemned both at the same instant — and the throttled case is a working command reported as
  /// `TEXT_INPUT_COMMIT_NOT_OBSERVED`, which is what turned an environment episode into a red
  /// lane on branches touching no iOS code.
  ///
  /// So time is granted against *progress* — the observed value's expected-prefix growing, the
  /// same length-only evidence `logCommitCadence` already emits — with an absolute `ceiling`, so a
  /// pipeline delivering one character per stall window cannot hold a command open forever. A
  /// pipeline making no progress at all still expires at exactly the `stallBudget` the flat
  /// deadline used, so nothing that fails today starts passing merely by waiting longer.
  ///
  /// Started by the poll loop from its own first `now()`, and held as a local `var` there. The
  /// wait's setup reads the field's placeholder first, an AX round-trip that takes seconds on
  /// exactly the loaded host this exists for; charging that to the deadline made the wait give up
  /// sooner than the flat budget it replaced.
  struct SynthesizedCommitDeadline {
    private let startedAt: Date
    private let stallBudget: TimeInterval
    private let ceiling: TimeInterval
    // Nothing has landed yet, and an observation of "still nothing" must not read as progress.
    private var bestPrefixLength = 0
    private var lastProgressAt: Date

    init(startedAt: Date, stallBudget: TimeInterval, ceiling: TimeInterval) {
      self.startedAt = startedAt
      self.stallBudget = stallBudget
      self.ceiling = ceiling
      self.lastProgressAt = startedAt
    }

    /// Records one observation's expected-prefix length. Only forward movement counts: a shorter
    /// read — the app clearing the field mid-flight, or a value that could not be read at all,
    /// which measures as 0 — is not evidence the burst is still landing, so it neither buys time
    /// nor takes any back.
    mutating func record(expectedPrefixLength: Int, at now: Date) {
      guard expectedPrefixLength > bestPrefixLength else { return }
      bestPrefixLength = expectedPrefixLength
      lastProgressAt = now
    }

    func isExpired(at now: Date) -> Bool {
      now.timeIntervalSince(startedAt) >= ceiling
        || now.timeIntervalSince(lastProgressAt) >= stallBudget
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
    let waitStartedAt = Date()
    NSLog("[DEBUG-1874] wait start expectedLen=%ld route=append", expectedText.count)
    let ingredients = synthesizedCommitPollingIngredients(app: app, target: target, expectedText: expectedText)
    let outcome = Self.awaitSynthesizedCommitOutcome(
      expectedText: expectedText,
      placeholder: ingredients.placeholder,
      now: { Date() },
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
      now: { Date() },
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

  /// The placeholder/observe/pacing ingredients shared by the append route
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
    observe: () -> String?,
    waitForNextObservation: () -> Void
  ) {
    let placeholder = resolveTextEntryElement(app: app, target: target)?.placeholderValue
    let waitStartedAt = Date()
    return (
      placeholder: placeholder,
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
}
