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
        ? RunnerSynthesizedTextEntry.replaceText(
          withApplication: app,
          text: text,
          charactersPerSecond: TextEntryTiming.synthesizedCharactersPerSecond
        )
        : RunnerSynthesizedTextEntry.synthesizeText(
          withApplication: app,
          text: text,
          charactersPerSecond: TextEntryTiming.synthesizedCharactersPerSecond
        )
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

  /// One synthesized text-entry plan: the posts a command makes, in the order it makes them, each
  /// with the wait that follows it. The delivery budget charges this array and the dispatch loop
  /// posts this same array, so the ceiling a command is refused against can never be a projection
  /// of a plan the runner did not run (#2955).
  struct SynthesizedTextPlan: Equatable {
    /// One post. `characterCount` characters of the text, taken in order, are what it types.
    struct Step: Equatable {
      let characterCount: Int
      /// True when this post selects the field's existing value away first. That selection is its
      /// own synthesize record, so the post costs one call more than typing characters.
      var replacesExistingText = false
      /// Seconds charged for what follows this post: the `--delay-ms` gap before the next post, or
      /// the warmup read-back after a peeled first character. The read-back costs one poll, because
      /// the route that needs a budget has no element to read the character back from and its wait
      /// cannot be longer than one poll of a value nobody can observe.
      var pauseAfterSeconds: TimeInterval = 0
      /// Set on the post whose value the loop waits for before the rest is posted.
      var warmsUpField = false

      /// How many private synthesize records this post runs.
      var synthesizeCallCount: Int {
        replacesExistingText ? 2 : 1
      }
    }

    let steps: [Step]

    /// One post per character, `delaySeconds` charged after every post but the last. A replacement
    /// selects once, on its first post; an append never selects.
    static func spacedSteps(
      characterCount: Int,
      delaySeconds: Double,
      replacesExistingTextOnFirstPost: Bool = false
    ) -> [Step] {
      (0..<characterCount).map { index in
        Step(
          characterCount: 1,
          replacesExistingText: replacesExistingTextOnFirstPost && index == 0,
          pauseAfterSeconds: index + 1 < characterCount ? delaySeconds : 0
        )
      }
    }

    /// Wall clock this plan spends posting: each post types its characters at the pace and pays for
    /// every synthesize record it runs, and each wait in front of the next post is charged once.
    var seconds: TimeInterval {
      steps.reduce(0) { total, step in
        total
          + Double(step.characterCount) * TextEntryTiming.synthesizedCharacterInterval
          + Double(step.synthesizeCallCount) * TextEntryTiming.synthesizeCallOverhead
          + step.pauseAfterSeconds
      }
    }

    /// Whether the plan hands the text over one character at a time, which is what a `--delay-ms`
    /// request builds. A burst is a single post and a repair peels a warmup character, so both keep
    /// a phase log per post; a paced plan logs one phase for the whole delivery instead.
    var pacesEveryCharacter: Bool {
      steps.count > 1 && !steps.contains(where: \.warmsUpField)
    }
  }

  /// Whether a text is posted one character per synthesize call, `delaySeconds` apart, rather than
  /// as one burst. The one place this is decided for every synthesized route.
  static func synthesizedDeliveryIsSpaced(characterCount: Int, delaySeconds: Double) -> Bool {
    delaySeconds > 0 && characterCount > 1
  }

  /// The posts a synthesized command makes.
  ///
  /// - A spaced request posts one character per call with the requested gap between calls; a
  ///   `fill` selects once, on its first post, and a `type` never selects.
  /// - A burst is one post, which a `fill` selects away first.
  /// - A burst from a command that repairs peels one character instead, because a field whose app
  ///   owns its value can reject the whole burst on the first edit's write-back; the rest follows
  ///   after the warmup read-back.
  static func synthesizedTextPlan(
    characterCount: Int,
    delaySeconds: Double,
    selectsExistingText: Bool,
    peelsWarmupCharacter: Bool = false
  ) -> SynthesizedTextPlan {
    if synthesizedDeliveryIsSpaced(characterCount: characterCount, delaySeconds: delaySeconds) {
      return SynthesizedTextPlan(
        steps: SynthesizedTextPlan.spacedSteps(
          characterCount: characterCount,
          delaySeconds: delaySeconds,
          replacesExistingTextOnFirstPost: selectsExistingText
        )
      )
    }
    guard peelsWarmupCharacter && characterCount > 1 else {
      return SynthesizedTextPlan(
        steps: [
          SynthesizedTextPlan.Step(
            characterCount: characterCount,
            replacesExistingText: selectsExistingText
          ),
        ]
      )
    }
    return SynthesizedTextPlan(
      steps: [
        SynthesizedTextPlan.Step(
          characterCount: 1,
          pauseAfterSeconds: TextEntryTiming.pollInterval,
          warmsUpField: true
        ),
        SynthesizedTextPlan.Step(characterCount: characterCount - 1),
      ]
    )
  }

  /// What a plan may not cost: more wall clock than the command has left to post characters. It is
  /// asked before the first character is dispatched, from the array about to be posted.
  enum SynthesizedDeliveryBudget {
    static func exceeds(_ plan: SynthesizedTextPlan) -> Bool {
      plan.seconds > TextEntryTiming.synthesizedDeliveryCeiling
    }

    /// Longest text a replacement at `delaySeconds` still admits, which is the number the refusal
    /// tells the caller. It asks the same plan admission judges, so the recovery hint can never
    /// promise a length the route then refuses.
    static func maxTextLength(delaySeconds: TimeInterval) -> Int {
      var length = 1
      while !exceeds(
        synthesizedTextPlan(
          characterCount: length + 1,
          delaySeconds: delaySeconds,
          selectsExistingText: true
        )
      ) {
        length += 1
      }
      return length
    }
  }

  /// Where one post leaves the plan: move on to the next step, or stop the command with a reason the
  /// route has already reported.
  enum SynthesizedStepDispatch {
    case posted
    case stop
  }

  struct SynthesizedPlanRun {
    let postedCharacterCount: Int
    /// True when a post stopped the plan before its last step.
    let stoppedEarly: Bool
  }

  /// Posts a plan the delivery budget just charged: each step slices the next characters off the
  /// text, and every wait the plan carries is taken. Both synthesized routes post through here so the
  /// array a command is refused against cannot drift from the posts the command makes (#2955).
  ///
  /// `waitAfterWarmupCharacter` replaces the charged pause on a warmup step with what the route wants
  /// to wait on, handed the characters that post made. The route that has an
  /// element reads the peeled character back and waits up to `warmupValueTimeout` for the app to
  /// accept it; the route that needed a budget has no element, so its wait is the plan's one poll of
  /// a value nobody can observe. Both are waits against the same charge, which is why the read-back
  /// belongs to the route and the plan only carries the character it waits for.
  @MainActor
  func runSynthesizedTextPlan(
    _ plan: SynthesizedTextPlan,
    text: String,
    post: (_ characters: String, _ step: SynthesizedTextPlan.Step) -> SynthesizedStepDispatch,
    waitAfterWarmupCharacter: (_ characters: String) -> Void,
    didPostStep: (_ step: SynthesizedTextPlan.Step) -> Void = { _ in }
  ) -> SynthesizedPlanRun {
    let characters = Array(text)
    var postedCount = 0
    for step in plan.steps {
      let nextCount = postedCount + step.characterCount
      if post(String(characters[postedCount..<nextCount]), step) == .stop {
        // The stopped post never delivered its slice, so the run reports what did arrive.
        return SynthesizedPlanRun(postedCharacterCount: postedCount, stoppedEarly: true)
      }
      postedCount = nextCount
      didPostStep(step)
      if step.warmsUpField {
        waitAfterWarmupCharacter(String(characters[postedCount - step.characterCount..<postedCount]))
      } else if step.pauseAfterSeconds > 0 {
        sleepFor(step.pauseAfterSeconds)
      }
    }
    return SynthesizedPlanRun(postedCharacterCount: postedCount, stoppedEarly: false)
  }

  @MainActor
  func runSynthesizedReplacementRoute(
    _ request: SynthesizedReplacementRequest
  ) -> SynthesizedReplacementRouteOutcome {
#if os(iOS)
    NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_ROUTE route=synthesized-first-responder-replacement")
    let plan = Self.synthesizedTextPlan(
      characterCount: request.text.count,
      delaySeconds: request.delaySeconds,
      selectsExistingText: true
    )
    if SynthesizedDeliveryBudget.exceeds(plan) {
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
    // A private synthesis channel that is gone mid-plan leaves the command the same
    // point-and-focus fallback it had before the plan existed.
    let synthesisAvailable = runSynthesizedTextPlan(
      plan,
      text: request.text,
      post: { slice, step in
        switch request.synthesizer.enterText(
          app: request.app,
          text: slice,
          replacingExistingText: step.replacesExistingText
        ) {
        case .continueTyping:
          return .posted
        case .fallback:
          return .stop
        case .raise(let message):
          NSException(
            name: NSExceptionName.internalInconsistencyException,
            reason: message ?? "private XCTest text synthesis failed"
          ).raise()
          return .stop
        }
      },
      // A replacement never peels a warmup character, so no step asks for a read-back.
      waitAfterWarmupCharacter: { _ in }
    )
    if synthesisAvailable.stoppedEarly {
      NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_ROUTE route=verified-fallback reason=synthesis-unavailable")
      guard let point = request.target.refreshPoint else { return .notApplicable }
      return .fallback(
        focusTextInputForTextEntry(app: request.app, x: point.x, y: point.y)
      )
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
