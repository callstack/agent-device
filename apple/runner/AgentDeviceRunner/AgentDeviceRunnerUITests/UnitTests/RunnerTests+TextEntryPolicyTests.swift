import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
#if os(iOS)
  final class RecordingTextEntrySynthesizer: TextEntrySynthesizing {
    var steps: [SynthesizedReplacementStep] = []

    func enterText(
      app _: XCUIApplication,
      text: String,
      replacingExistingText: Bool
    ) -> SynthesizedTextEntryAction {
      steps.append(
        SynthesizedReplacementStep(
          text: text,
          replacesExistingText: replacingExistingText
        )
      )
      return .continueTyping
    }
  }
#endif

  func testSynthesizedReplacementRequiresPenalizedXCTestAndCoordinates() {
    let cases = [
      (hasElement: false, hasPoint: true, penalized: true, expected: true),
      (hasElement: false, hasPoint: true, penalized: false, expected: false),
      (hasElement: false, hasPoint: false, penalized: true, expected: false),
      (hasElement: true, hasPoint: true, penalized: true, expected: false),
    ]
    for testCase in cases {
      XCTAssertEqual(
        Self.shouldUseSynthesizedFirstResponderReplacement(
          hasResolvedElement: testCase.hasElement,
          hasRefreshPoint: testCase.hasPoint,
          xCTestChannelPenalized: testCase.penalized
        ),
        testCase.expected
      )
    }
  }

  func testSynthesizedFirstResponderTypeAdmitsOnlyTheBareSubmitKeyAfterAHiddenKeyboardTap() {
    let cases: [(TextTypingRepairMode, String, Bool, Bool, Bool)] = [
      (.none, "\n", true, false, true),
      (.none, "\n", true, true, false),
      (.none, "\n", false, false, false),
      (.none, "hardware-keyboard", true, false, false),
      (.none, "\r", true, false, false),
      (.none, "search\n", true, false, false),
      (.append, "\n", true, false, false),
      (.append, "hardware-keyboard", true, false, false),
      (.replacement, "\n", true, false, false),
    ]
    for (mode, text, fromTapWitness, softwareKeyboardVisible, expected) in cases {
      XCTAssertEqual(
        Self.shouldUseSynthesizedFirstResponderType(
          repairMode: mode,
          text: text,
          fromTapWitness: fromTapWitness,
          softwareKeyboardVisible: softwareKeyboardVisible
        ),
        expected,
        "mode: \(mode), text: \(text.debugDescription)"
      )
    }
  }

  // The guard must stay narrow: it fires only when the WHOLE expected value is the placeholder.
  // Widening it would refuse ordinary entry into any placeheld field, which is most of them.
  func testPlaceholderGuardDoesNotFireOnOrdinaryTyping() {
    let cases: [(placeholder: String?, expectedText: String)] = [
      ("0.00", "0.005"),
      ("Email", "ada@example.test"),
      (nil, "0.00"),
      ("", ""),
      ("   ", ""),
    ]
    for testCase in cases {
      let outcome = Self.awaitSynthesizedReplacementCommitOutcome(
        expectedText: testCase.expectedText,
        placeholder: testCase.placeholder,
        observe: { testCase.expectedText },
        waitForNextObservation: {}
      )
      XCTAssertEqual(outcome, .settled, "placeholder: \(testCase.placeholder ?? "nil")")
    }
  }

  // A value with a hole in the middle is neither a matching prefix nor an exact match, and must
  // never settle. These are the two corruption strings actually observed in CI on `fill`
  // (id="field-name" "Ada Lovelace" -> "Avelace", id="field-email" "ada@example" -> "aexample";
  // first character and tail survive, a middle run is missing). The wait can refuse a value like
  // this but not repair it: no later read distinguishes it from a field that has settled.
  func testSynthesizedReplacementCommitCatchesMiddleRunMissingFromTheField() {
    let corruptions: [(expected: String, observedAfterDrop: String)] = [
      (expected: "Ada Lovelace", observedAfterDrop: "Avelace"),
      (expected: "ada@example", observedAfterDrop: "aexample"),
    ]
    for corruption in corruptions {
      let clock = CommitWaitClock()
      var polls = 0
      let outcome = Self.awaitSynthesizedReplacementCommitOutcome(
        expectedText: corruption.expected,
        placeholder: nil,
        stallBudget: 2,
        ceiling: 10,
        now: clock.read,
        observe: { corruption.observedAfterDrop },
        waitForNextObservation: {
          polls += 1
          clock.advance(1)
        }
      )
      XCTAssertEqual(outcome, .notObserved, "expected \(corruption.expected), dropped to \(corruption.observedAfterDrop)")
      XCTAssertEqual(polls, 2, "a settled-but-wrong value must be polled until the deadline, not trusted early")
    }
  }

  // The non-failure counterpart: replacement mode must still tolerate real commit lag (the value
  // converges to an exact match over a few polls), not just instant matches.
  func testSynthesizedReplacementCommitToleratesLagUntilExactMatch() {
    let steps = ["", "ad", "ada@example"]
    var index = 0
    let outcome = Self.awaitSynthesizedReplacementCommitOutcome(
      expectedText: "ada@example",
      placeholder: nil,
      observe: { steps[min(index, steps.count - 1)] },
      waitForNextObservation: { index += 1 }
    )
    XCTAssertEqual(outcome, .settled)
    XCTAssertEqual(index, 2)
  }

  // The deadline is checked AFTER an observation, so a match landing during the final poll sleep
  // is still caught.
  func testSynthesizedReplacementCommitLandingDuringTheFinalSleepIsStillObserved() {
    let clock = CommitWaitClock()
    var polls = 0
    let outcome = Self.awaitSynthesizedReplacementCommitOutcome(
      expectedText: "ada@example",
      placeholder: nil,
      stallBudget: 3,
      ceiling: 10,
      now: clock.read,
      observe: { polls == 0 ? "ada@exampl" : "ada@example" },
      waitForNextObservation: {
        polls += 1
        clock.advance(9)
      }
    )
    XCTAssertEqual(outcome, .settled)
  }

  // A pre-dispatch value cannot identify what a later placeholder-equal AX value represents: an
  // input handler may clear the field after dispatch and the empty field then renders the
  // placeholder. Reporting success would describe an empty field as committed text.
  func testSynthesizedReplacementCommitPlaceholderGuardRefusesWithoutPolling() {
    var observations = 0
    let outcome = Self.awaitSynthesizedReplacementCommitOutcome(
      expectedText: "0.00",
      placeholder: "0.00",
      observe: {
        observations += 1
        return "0.00"
      },
      waitForNextObservation: {}
    )
    XCTAssertEqual(Self.textEntryFailure(forCommitOutcome: outcome)?.rawValue, "TEXT_INPUT_COMMIT_NOT_OBSERVED")
    XCTAssertEqual(observations, 0, "no post-dispatch read can resolve this collision")
  }

  // The mapping the command actually refuses on. `.unobservable` must stay a success: it is the
  // contract for submit-key text, so inverting it would fail every `fill` ending in a submit key.
  func testOnlyAnUnobservedCommitBecomesACommandFailure() {
    XCTAssertNil(Self.textEntryFailure(forCommitOutcome: .settled))
    XCTAssertNil(Self.textEntryFailure(forCommitOutcome: .unobservable))
    XCTAssertEqual(Self.textEntryFailure(forCommitOutcome: .notObserved), .commitNotObserved)
  }

  func testCommitNotObservedCarriesItsOwnCodeAndRecovery() {
    XCTAssertEqual(TextEntryFailure.commitNotObserved.rawValue, "TEXT_INPUT_COMMIT_NOT_OBSERVED")
    // The recovery has to name fill: `type` appends, so retrying it over a partial value would
    // concatenate onto whatever committed rather than repair it.
    XCTAssertTrue(TextEntryFailure.commitNotObserved.hint.contains("fill"))
    // And it must not assert a field state the runner never read — the value may be complete.
    XCTAssertFalse(TextEntryFailure.commitNotObserved.message.contains("only part"))
  }

#if os(iOS)
  func testSynthesizedTextEntryFallsBackOnlyWhenPrivateSynthesisIsUnavailable() {
    XCTAssertEqual(
      PrivateXCTestTextEntrySynthesizer.action(status: .succeeded, message: nil),
      .continueTyping
    )
    XCTAssertEqual(
      PrivateXCTestTextEntrySynthesizer.action(status: .unavailable, message: nil),
      .fallback
    )
    XCTAssertEqual(
      PrivateXCTestTextEntrySynthesizer.action(status: .failed, message: "failed"),
      .raise("failed")
    )
  }
#endif

  func testResolvedCoordinateTextEntryRouteRequiresReplacementCoordinatesAndPenalizedXCTest() {
    let cases: [(TextTypingRepairMode, Bool, Bool, Bool, Bool)] = [
      (.replacement, true, true, false, false),
      (.replacement, true, true, true, true),
      (.append, true, true, true, false),
      (.replacement, false, true, true, false),
      (.replacement, true, false, true, false),
    ]
    for (mode, hasX, hasY, penalized, expected) in cases {
      XCTAssertEqual(
        Self.shouldUseResolvedCoordinateTextEntryRoute(
          repairMode: mode,
          hasX: hasX,
          hasY: hasY,
          xCTestChannelPenalized: penalized
        ),
        expected
      )
    }
  }

  func testSynthesizedReplacementPacesCharactersAfterSelectingOnce() {
    XCTAssertEqual(
      Self.synthesizedReplacementSteps(text: "abc", delaySeconds: 0.05),
      [
        SynthesizedReplacementStep(text: "a", replacesExistingText: true),
        SynthesizedReplacementStep(text: "b", replacesExistingText: false),
        SynthesizedReplacementStep(text: "c", replacesExistingText: false),
      ]
    )
    XCTAssertEqual(
      Self.synthesizedReplacementSteps(text: "abc", delaySeconds: 0),
      [SynthesizedReplacementStep(text: "abc", replacesExistingText: true)]
    )
  }

  // The pace is what keeps a field the app owns from losing most of a replacement (#2080), so it
  // cannot drift on its own: one character interval has to leave that app at least twice the
  // acknowledge window the route is sized for. The host lane runs this on every PR; the iOS lane's
  // app-owned-value test checks the spacing the app actually receives.
  func testSynthesizedPaceLeavesRoomForAnAppToAcknowledgeEachEdit() {
    XCTAssertGreaterThanOrEqual(
      SynthesizedDeliveryBudget.characterInterval,
      2 * TextEntryTiming.synthesizedAcknowledgeWindowSeconds
    )
  }

  // Characters are delivered while the private synthesize call is still running, so text longer
  // than the delivery ceiling would still be arriving when the main-thread watchdog abandons the
  // command. The budget turns that into a refusal decided up front, at the boundary and not after
  // the first character is posted.
  func testSynthesizedDeliveryBudgetRefusesTextThatOutrunsTheCommand() {
    let fits = SynthesizedDeliveryBudget.maxTextLength(delaySeconds: 0)
    XCTAssertGreaterThan(fits, 0)
    XCTAssertFalse(SynthesizedDeliveryBudget.exceeds(textLength: fits, delaySeconds: 0))
    XCTAssertTrue(SynthesizedDeliveryBudget.exceeds(textLength: fits + 1, delaySeconds: 0))
  }

  // A spaced plan posts each character in its own synthesize call and sleeps between two of them,
  // so a character costs the pace, the call's overhead and the delay together, not the larger of
  // pace and delay. The delay checked is the retry TEXT_INPUT_COMMIT_NOT_OBSERVED recommends.
  func testSpacedDeliveryBudgetChargesEachCharacterItsCallAndDelay() {
    let delay = Double(TextEntryTiming.recoveryDelayMilliseconds) / 1000
    let fits = SynthesizedDeliveryBudget.maxTextLength(delaySeconds: delay)
    XCTAssertFalse(SynthesizedDeliveryBudget.exceeds(textLength: fits, delaySeconds: delay))
    XCTAssertTrue(SynthesizedDeliveryBudget.exceeds(textLength: fits + 1, delaySeconds: delay))
    XCTAssertEqual(
      SynthesizedDeliveryBudget.projectedSeconds(textLength: 10, delaySeconds: delay)
        - SynthesizedDeliveryBudget.projectedSeconds(textLength: 9, delaySeconds: delay),
      SynthesizedDeliveryBudget.characterInterval
        + TextEntryTiming.synthesizeCallOverhead
        + delay,
      accuracy: 1e-9
    )
    XCTAssertLessThan(fits, SynthesizedDeliveryBudget.maxTextLength(delaySeconds: 0))
    XCTAssertLessThan(SynthesizedDeliveryBudget.maxTextLength(delaySeconds: 0.2), fits)
  }

  // A `type` plan peels one character as a warmup and posts the rest afterwards, so the same text
  // costs one synthesize call and one wait more than the single burst the replacement route posts.
  // Without this the estimate charged a burst, which is what made the over-budget branch of the
  // keyboard-visible route unreachable: 215 characters looked like 1 + 214, each inside the budget.
  func testTypeWarmupSplitCostsOneMoreCallThanASingleBurst() {
    let length = 20
    let withWarmup = SynthesizedDeliveryBudget.projectedSeconds(
      textLength: length,
      delaySeconds: 0,
      typeWarmup: true
    )
    XCTAssertGreaterThan(
      withWarmup,
      SynthesizedDeliveryBudget.projectedSeconds(textLength: length, delaySeconds: 0)
    )
    XCTAssertEqual(
      withWarmup - SynthesizedDeliveryBudget.projectedSeconds(textLength: length, delaySeconds: 0),
      TextEntryTiming.synthesizeCallOverhead + TextEntryTiming.pollInterval,
      accuracy: 1e-9
    )
    // The split mirrors the plan: a spaced `type` already posts per character, and a single
    // character has no rest to post.
    XCTAssertEqual(
      SynthesizedDeliveryBudget.projectedSeconds(textLength: length, delaySeconds: 0.2, typeWarmup: true),
      SynthesizedDeliveryBudget.projectedSeconds(textLength: length, delaySeconds: 0.2)
    )
    XCTAssertEqual(
      SynthesizedDeliveryBudget.projectedSeconds(textLength: 1, delaySeconds: 0, typeWarmup: true),
      SynthesizedDeliveryBudget.projectedSeconds(textLength: 1, delaySeconds: 0)
    )
  }

  func testSynthesizedBudgetExceededCarriesItsOwnCodeAndRecovery() {
    XCTAssertEqual(
      TextEntryFailure.synthesisBudgetExceeded.rawValue,
      "TEXT_INPUT_SYNTHESIS_BUDGET_EXCEEDED"
    )
    // The recovery has to tell the caller to split the text: waiting it out or raising a timeout
    // does nothing, because the pace is what makes the burst long, not the host being slow. A
    // delayed request fits fewer characters, so the hint names both budgets rather than promising
    // the undelayed one to a caller retrying with --delay-ms.
    let hint = TextEntryFailure.synthesisBudgetExceeded.hint
    XCTAssertTrue(hint.contains("\(SynthesizedDeliveryBudget.maxTextLength(delaySeconds: 0)) characters at a time"))
    let recoveryDelay = TextEntryTiming.recoveryDelayMilliseconds
    let recoveryBudget = SynthesizedDeliveryBudget.maxTextLength(
      delaySeconds: Double(recoveryDelay) / 1000
    )
    XCTAssertTrue(hint.contains("\(recoveryBudget) characters at --delay-ms \(recoveryDelay)"))
  }

#if os(iOS)
  func testTypeTextReliablyPacesSynthesizedReplacementThroughProductionCaller() {
    let synthesizer = RecordingTextEntrySynthesizer()
    // Springboard, not a bare `XCUIApplication()`: the commit wait now really polls (see below),
    // and each poll resolves `target.refreshPoint` through `textInputAt`, which queries the real
    // XCTest element-query channel. Against a bare, never-`.launch()`ed `XCUIApplication()` that
    // query throws `_XCTestCaseInterruptionException` ("Application ... is not running") on every
    // single poll — caught by `safely(...)` so production code never sees it, but XCTest's own
    // instrumentation independently records each occurrence as a test failure regardless, which
    // faked this test red under `xcodebuild test-without-building` despite every assertion below
    // passing (verified locally: 15 recorded failures, 0 of them from an XCTAssert). Springboard is
    // always running on a booted simulator without an explicit launch, so the same query instead
    // resolves normally to zero matching elements — this is not a workaround for a flaky query, it
    // is giving the query a fixture it can actually answer.
    let result = typeTextReliably(
      app: springboard,
      target: TextEntryTarget(
        element: nil,
        refreshPoint: CGPoint(x: 10, y: 20),
        prefersFocusedElement: false
      ),
      text: "abc",
      delaySeconds: 0.001,
      repairMode: .replacement,
      xCTestChannelPenalized: true,
      synthesizer: synthesizer
    )

    XCTAssertEqual(
      synthesizer.steps,
      [
        SynthesizedReplacementStep(text: "a", replacesExistingText: true),
        SynthesizedReplacementStep(text: "b", replacesExistingText: false),
        SynthesizedReplacementStep(text: "c", replacesExistingText: false),
      ]
    )
    XCTAssertNil(result.verified)
    XCTAssertFalse(result.repaired)
    XCTAssertEqual(result.textEntryRoute, "synthesized-first-responder-replacement")
    // The regression this pins: this route used to return here with no commit wait at all, so a
    // dropped or still-in-flight character was indistinguishable from success (the "ada@example"
    // landing as "aexample" CI signature). The fake synthesizer never actually writes into
    // Springboard, so the wait's `observe()` reads nil (no matching field at that point) on every
    // poll and the value never becomes "abc" — under the replacement-mode outcome function that is
    // correctly a failure (see `testSynthesizedReplacementCommitCatchesMiddleRunMissingFromTheField`
    // for why it must NOT be waved through as success), so this call runs the real 3-second deadline
    // (`TextEntryTiming.synthesizedCommitStallTimeout`; a nil read never advances the expected
    // prefix, so `SynthesizedCommitDeadline` grants it no extra time) before returning. That is
    // deliberate here, not a flake: this test only runs in the nightly XCUITest lane (see
    // `runner-xctest-local-run-gotchas` memory / ios.yml's `-only-testing:` allowlist), where a
    // few extra seconds is a non-issue, and the alternative — asserting `nil` on a wiring path
    // that can never actually observe the expected text — would silently reintroduce the exact
    // bug this fix closes.
    XCTAssertEqual(result.failure, .commitNotObserved)
  }

  // `fill <target> ""` is the clear-field primitive (#2063). When no clear target resolves —
  // Springboard's home screen has no focused text input — the empty-text replacement path must
  // fail closed: it used to fall through to the vacuous-typing early return and report
  // `verified: true` for a clear that never ran.
  func testEmptyReplacementWithoutResolvableTargetFailsClosed() {
    let result = typeTextReliably(
      app: springboard,
      target: TextEntryTarget(element: nil, refreshPoint: nil, prefersFocusedElement: false),
      text: "",
      delaySeconds: 0,
      repairMode: .replacement,
      xCTestChannelPenalized: false,
      synthesizer: RecordingTextEntrySynthesizer()
    )

    XCTAssertEqual(result.failure, .notFocused)
    XCTAssertNil(result.verified)
    XCTAssertNil(result.observedText)
  }

  // Companion to the above: text carrying a submit key must skip the wait entirely — the app may
  // clear or rewrite the field on submit, so there is nothing meaningful to poll toward.
  func testSynthesizedReplacementCommitSkipsSubmitKeyText() {
    for expectedText in ["ada@example.test\n", "ada@example.test\r"] {
      XCTAssertEqual(
        awaitSynthesizedReplacementCommit(
          app: XCUIApplication(),
          target: TextEntryTarget(element: nil, refreshPoint: CGPoint(x: 10, y: 20), prefersFocusedElement: false),
          expectedText: expectedText
        ),
        .unobservable
      )
    }
  }

  func testCommonPrefixLengthWalksTheExpectedPrefixOnly() {
    XCTAssertEqual(Self.commonPrefixLength("hardware-keyboard", "hardware-keyboard"), 17)
    XCTAssertEqual(Self.commonPrefixLength("h", "hardware-keyboard"), 1)
    XCTAssertEqual(Self.commonPrefixLength("ha", "hardware-keyboard"), 2)
    XCTAssertEqual(Self.commonPrefixLength("", "hardware-keyboard"), 0)
    // Divergence stops the count: the app transformed the input, and the walk must not
    // resume matching after the first differing character.
    XCTAssertEqual(Self.commonPrefixLength("hx", "hardware-keyboard"), 1)
    let sharedPrefix = "hardware-keyboar"
    XCTAssertEqual(
      Self.commonPrefixLength("\(sharedPrefix)x", "\(sharedPrefix)d"),
      sharedPrefix.count
    )
  }

  func testCommitCadenceLogLineEmitsLengthsOnlyNeverContents() {
    // Sentinel secret: even when the polled field holds credential-shaped content, the only
    // channel into runner.log is this line, and its inputs are lengths. The exact-equality
    // assert fails if any content-bearing parameter or interpolation is ever added.
    let secret = "hunter2-typed-credential"
    let line = Self.commitCadenceLogLine(
      elapsedMs: 42,
      observedLen: secret.count,
      expectedPrefixLen: 8
    )
    XCTAssertEqual(line, "[DEBUG-1874] poll t=42ms observedLen=24 expectedPrefixLen=8")
    XCTAssertFalse(line.contains(secret))
  }
#endif
#endif
}
