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

  func testSynthesizedFirstResponderTypeRequiresHiddenKeyboardTapWitness() {
    let cases: [(TextTypingRepairMode, Bool, Bool, Bool)] = [
      (.none, true, false, true),
      (.none, true, true, false),
      (.none, false, false, false),
      (.append, true, false, false),
      (.replacement, true, false, false),
    ]
    for (mode, fromTapWitness, softwareKeyboardVisible, expected) in cases {
      XCTAssertEqual(
        Self.shouldUseSynthesizedFirstResponderType(
          repairMode: mode,
          fromTapWitness: fromTapWitness,
          softwareKeyboardVisible: softwareKeyboardVisible
        ),
        expected
      )
    }
  }

  func testSynthesizedTextCommitProgressWalksExpectedPrefixOnly() {
    let expected = "hardware-keyboard"
    XCTAssertEqual(
      Self.synthesizedTextCommitProgress(observedText: "hardware-keyboard", expectedText: expected),
      .committed
    )
    XCTAssertEqual(
      Self.synthesizedTextCommitProgress(observedText: "", expectedText: expected),
      .pending
    )
    XCTAssertEqual(
      Self.synthesizedTextCommitProgress(observedText: "hardware-keyboa", expectedText: expected),
      .pending
    )
    // Transformed input (formatter, mid-text caret, autocomplete) must stop the wait.
    XCTAssertEqual(
      Self.synthesizedTextCommitProgress(observedText: "hardwarX", expectedText: expected),
      .diverged
    )
    XCTAssertEqual(
      Self.synthesizedTextCommitProgress(observedText: "hardware-keyboards", expectedText: expected),
      .diverged
    )
    XCTAssertEqual(
      Self.synthesizedTextCommitProgress(observedText: nil, expectedText: expected),
      .diverged
    )
  }

  // The regression behind #1874/#1844: the wait used to return Void, so an expired deadline was
  // indistinguishable from a commit and `type` reported ok over a partially committed field. The
  // CI signature was a field holding "h" out of "hardware-keyboard" with the command successful.
  func testSynthesizedCommitDeadlineIsNotReportedAsACommit() {
    var observations = 0
    let outcome = Self.awaitSynthesizedCommitOutcome(
      expectedText: "hardware-keyboard",
      isExpired: { observations >= 3 },
      observe: { "h" },
      waitForNextObservation: { observations += 1 }
    )
    XCTAssertEqual(outcome, .notObserved)
    XCTAssertEqual(observations, 3, "a pending prefix must keep polling until the deadline")
  }

  func testSynthesizedCommitStopsAtTheFirstSettledObservation() {
    for observed in ["hardware-keyboard", "hardwarX", nil] {
      var polls = 0
      let outcome = Self.awaitSynthesizedCommitOutcome(
        expectedText: "hardware-keyboard",
        isExpired: { false },
        observe: { observed },
        waitForNextObservation: { polls += 1 }
      )
      // `.diverged` settles the wait too: the app transformed the input and the runner must not
      // second-guess it. Only an outstanding strict prefix keeps waiting.
      XCTAssertEqual(outcome, .settled, "observed: \(observed ?? "nil")")
      XCTAssertEqual(polls, 0, "observed: \(observed ?? "nil")")
    }
  }

  func testSynthesizedCommitWalksAPrefixToCompletion() {
    let steps = ["", "hardware-", "hardware-keyboard"]
    var index = 0
    let outcome = Self.awaitSynthesizedCommitOutcome(
      expectedText: "hardware-keyboard",
      isExpired: { false },
      observe: { steps[min(index, steps.count - 1)] },
      waitForNextObservation: { index += 1 }
    )
    XCTAssertEqual(outcome, .settled)
    XCTAssertEqual(index, 2)
  }

  // Adversarial-review finding: the deadline used to be checked BEFORE observing, so a commit
  // landing during the final poll sleep was condemned as never observed — a false failure under
  // exactly the loaded-host timing this wait exists for. Red against that ordering.
  func testCommitLandingDuringTheFinalSleepIsStillObserved() {
    var polls = 0
    let outcome = Self.awaitSynthesizedCommitOutcome(
      expectedText: "hardware-keyboard",
      isExpired: { polls >= 1 },
      observe: { polls == 0 ? "hardware-" : "hardware-keyboard" },
      waitForNextObservation: { polls += 1 }
    )
    XCTAssertEqual(outcome, .settled)
  }

  // Adversarial-review finding: `treatingPlaceholderAsEmpty` maps a value equal to the field's
  // placeholder to "", a prefix of everything. Typing a string that equals the placeholder
  // committed instantly yet read as pending until the deadline. The observation now settles on an
  // exact raw match, so this is the wait's view of that field.
  func testValueEqualToThePlaceholderSettlesInsteadOfStallingUntilTheDeadline() {
    var polls = 0
    let outcome = Self.awaitSynthesizedCommitOutcome(
      expectedText: "0.00",
      isExpired: { polls >= 4 },
      // What the fixed observe closure yields once the raw value matches: the exact text, not the
      // placeholder-normalized "" that the prefix walk would treat as still pending.
      observe: { "0.00" },
      waitForNextObservation: { polls += 1 }
    )
    XCTAssertEqual(outcome, .settled)
    XCTAssertEqual(polls, 0, "an exact match must not poll at all")
  }

  // The mapping the command actually refuses on. `.unobservable` must stay a success: it is the
  // pre-existing contract for submit-key text and unreadable fields, so inverting it would fail
  // every `type "...\n"`.
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

  func testResolvedCoordinateTextEntryFallsBackWhenSynthesizedFocusIsUnavailable() {
    XCTAssertFalse(Self.shouldFallbackFromSynthesizedTextEntryFocus(.performed))
    XCTAssertTrue(
      Self.shouldFallbackFromSynthesizedTextEntryFocus(
        .unsupported(message: "private synthesis unavailable", hint: "use XCTest")
      )
    )
  }

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

#if os(iOS)
  func testTypeTextReliablyPacesSynthesizedReplacementThroughProductionCaller() {
    let synthesizer = RecordingTextEntrySynthesizer()
    let result = typeTextReliably(
      app: XCUIApplication(),
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
  }
#endif
#endif
}
