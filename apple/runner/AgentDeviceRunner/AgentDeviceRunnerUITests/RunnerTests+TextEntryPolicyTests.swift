import XCTest

extension RunnerTests {
  func testSynthesizedReplacementRequiresResolvedTextInputEvidenceAndCoordinates() {
    XCTAssertTrue(
      Self.shouldUseSynthesizedFirstResponderReplacement(
        hasResolvedElement: false,
        hasRefreshPoint: true,
        resolvedTextInputTarget: true
      )
    )
    XCTAssertFalse(
      Self.shouldUseSynthesizedFirstResponderReplacement(
        hasResolvedElement: false,
        hasRefreshPoint: true,
        resolvedTextInputTarget: false
      )
    )
    XCTAssertFalse(
      Self.shouldUseSynthesizedFirstResponderReplacement(
        hasResolvedElement: false,
        hasRefreshPoint: false,
        resolvedTextInputTarget: true
      )
    )
    XCTAssertFalse(
      Self.shouldUseSynthesizedFirstResponderReplacement(
        hasResolvedElement: true,
        hasRefreshPoint: true,
        resolvedTextInputTarget: true
      )
    )
  }

  func testResolvedCoordinateTextEntryRouteRequiresReplacementCoordinatesAndTypedEvidence() {
    XCTAssertTrue(
      Self.shouldUseResolvedCoordinateTextEntryRoute(
        repairMode: .replacement,
        hasX: true,
        hasY: true,
        resolvedTextInputTarget: true
      )
    )
    XCTAssertFalse(
      Self.shouldUseResolvedCoordinateTextEntryRoute(
        repairMode: .append,
        hasX: true,
        hasY: true,
        resolvedTextInputTarget: true
      )
    )
    XCTAssertFalse(
      Self.shouldUseResolvedCoordinateTextEntryRoute(
        repairMode: .replacement,
        hasX: false,
        hasY: true,
        resolvedTextInputTarget: true
      )
    )
    XCTAssertFalse(
      Self.shouldUseResolvedCoordinateTextEntryRoute(
        repairMode: .replacement,
        hasX: true,
        hasY: true,
        resolvedTextInputTarget: false
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
}
