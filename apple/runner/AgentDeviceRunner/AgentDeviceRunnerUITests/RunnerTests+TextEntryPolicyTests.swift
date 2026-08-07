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
