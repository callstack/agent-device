import XCTest

extension RunnerTests {
#if os(iOS)
  final class RecordingTextEntrySynthesizer: TextEntrySynthesizing {
    var steps: [SynthesizedReplacementStep] = []

    func synthesizeText(app _: XCUIApplication, text: String) -> SynthesizedTextEntryAttempt {
      steps.append(SynthesizedReplacementStep(text: text, replacesExistingText: false))
      return SynthesizedTextEntryAttempt(status: .succeeded, message: nil)
    }

    func replaceText(app _: XCUIApplication, text: String) -> SynthesizedTextEntryAttempt {
      steps.append(SynthesizedReplacementStep(text: text, replacesExistingText: true))
      return SynthesizedTextEntryAttempt(status: .succeeded, message: nil)
    }
  }
#endif

  func testSynthesizedReplacementRequiresPenalizedXCTestAndCoordinates() {
    XCTAssertTrue(
      Self.shouldUseSynthesizedFirstResponderReplacement(
        hasResolvedElement: false,
        hasRefreshPoint: true,
        xCTestChannelPenalized: true
      )
    )
    XCTAssertFalse(
      Self.shouldUseSynthesizedFirstResponderReplacement(
        hasResolvedElement: false,
        hasRefreshPoint: true,
        xCTestChannelPenalized: false
      )
    )
    XCTAssertFalse(
      Self.shouldUseSynthesizedFirstResponderReplacement(
        hasResolvedElement: false,
        hasRefreshPoint: false,
        xCTestChannelPenalized: true
      )
    )
    XCTAssertFalse(
      Self.shouldUseSynthesizedFirstResponderReplacement(
        hasResolvedElement: true,
        hasRefreshPoint: true,
        xCTestChannelPenalized: true
      )
    )
  }

  func testSynthesizedTextEntryFallsBackOnlyWhenPrivateSynthesisIsUnavailable() {
    XCTAssertEqual(
      Self.synthesizedTextEntryDisposition(status: .succeeded),
      .continueTyping
    )
    XCTAssertEqual(
      Self.synthesizedTextEntryDisposition(status: .unavailable),
      .fallback
    )
    XCTAssertEqual(Self.synthesizedTextEntryDisposition(status: .failed), .raise)
  }

  func testResolvedCoordinateTextEntryFallsBackWhenSynthesizedFocusIsUnavailable() {
    XCTAssertFalse(Self.shouldFallbackFromSynthesizedTextEntryFocus(.performed))
    XCTAssertTrue(
      Self.shouldFallbackFromSynthesizedTextEntryFocus(
        .unsupported(message: "private synthesis unavailable", hint: "use XCTest")
      )
    )
  }

  func testResolvedCoordinateTextEntryRouteRequiresReplacementCoordinatesAndPenalizedXCTest() {
    XCTAssertFalse(
      Self.shouldUseResolvedCoordinateTextEntryRoute(
        repairMode: .replacement,
        hasX: true,
        hasY: true,
        xCTestChannelPenalized: false
      )
    )
    XCTAssertTrue(
      Self.shouldUseResolvedCoordinateTextEntryRoute(
        repairMode: .replacement,
        hasX: true,
        hasY: true,
        xCTestChannelPenalized: true
      )
    )
    XCTAssertFalse(
      Self.shouldUseResolvedCoordinateTextEntryRoute(
        repairMode: .append,
        hasX: true,
        hasY: true,
        xCTestChannelPenalized: true
      )
    )
    XCTAssertFalse(
      Self.shouldUseResolvedCoordinateTextEntryRoute(
        repairMode: .replacement,
        hasX: false,
        hasY: true,
        xCTestChannelPenalized: true
      )
    )
    XCTAssertFalse(
      Self.shouldUseResolvedCoordinateTextEntryRoute(
        repairMode: .replacement,
        hasX: true,
        hasY: false,
        xCTestChannelPenalized: true
      )
    )
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
  }
#endif
}
