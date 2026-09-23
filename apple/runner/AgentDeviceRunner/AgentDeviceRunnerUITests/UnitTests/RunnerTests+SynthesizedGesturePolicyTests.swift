import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
extension RunnerTests {
  func testSynthesizedGesturePolicyMarkerWritesOncePerKindUntilTheDecisionChanges() {
    var written: [String] = []
    runnerMarkerWriter = { written.append($0) }
    defer {
      runnerMarkerWriter = { NSLog("%@", $0) }
      invalidateCachedTarget(reason: "unit_test_cleanup")
    }
    logSynthesizedGesturePolicyDecision(kind: .coordinateTap, context: nil, fallbackAttempted: false)
    logSynthesizedGesturePolicyDecision(kind: .coordinateTap, context: nil, fallbackAttempted: false)
    XCTAssertEqual(written.count, 1, "a repeated decision writes no second line")
    logSynthesizedGesturePolicyDecision(kind: .scroll, context: nil, fallbackAttempted: false)
    XCTAssertEqual(written.count, 2, "each gesture kind states its own decision")
    logSynthesizedGesturePolicyDecision(kind: .coordinateTap, context: nil, fallbackAttempted: true)
    XCTAssertEqual(written.count, 3, "a changed decision writes a new line")
    resetTargetBoundState()
    logSynthesizedGesturePolicyDecision(kind: .coordinateTap, context: nil, fallbackAttempted: true)
    XCTAssertEqual(written.count, 4, "a rebind states the same decision once more")
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testSynthesizedFallbackPolicyRequiresPrivateSynthesisForScrollWhenAxUnavailableOrUnknown() {
    XCTAssertFalse(
      SynthesizedFallbackPolicy.privateSynthesisRequired
        .allowsXCTestCoordinateFallback(accessibilityHealth: .unavailable)
    )
    XCTAssertFalse(
      SynthesizedFallbackPolicy.privateSynthesisRequired
        .allowsXCTestCoordinateFallback(accessibilityHealth: .unknown)
    )
    XCTAssertFalse(
      SynthesizedFallbackPolicy.privateSynthesisRequired
        .allowsXCTestCoordinateFallback(accessibilityHealth: .healthy)
    )
  }

  func testSynthesizedDragCoordinateFallbackAllowsUnknownButNotUnavailableAccessibility() {
    XCTAssertTrue(
      SynthesizedFallbackPolicy.xctestCoordinateWhenAccessibilityAvailable
        .allowsXCTestCoordinateFallback(accessibilityHealth: .healthy)
    )
    XCTAssertFalse(
      SynthesizedFallbackPolicy.xctestCoordinateWhenAccessibilityAvailable
        .allowsXCTestCoordinateFallback(accessibilityHealth: .unavailable)
    )
    XCTAssertTrue(
      SynthesizedFallbackPolicy.xctestCoordinateWhenAccessibilityAvailable
        .allowsXCTestCoordinateFallback(accessibilityHealth: .unknown)
    )
  }

  /// Keyboard-policy semantics only. Which command gets which policy is the table below; a probe
  /// that is merely permitted still costs a live AX fetch, so the two questions stay separate.
  func testSynthesizedKeyboardPolicyAllowsProbeOnlyWhenAccessibilityPermitsIt() {
    XCTAssertFalse(
      SynthesizedKeyboardPolicy.whenAccessibilityHealthy
        .allowsProbe(accessibilityHealth: .unknown)
    )
    XCTAssertTrue(
      SynthesizedKeyboardPolicy.requiredWhenAvailable
        .allowsProbe(accessibilityHealth: .unknown)
    )
    XCTAssertFalse(
      SynthesizedKeyboardPolicy.requiredWhenAvailable
        .allowsProbe(accessibilityHealth: .unavailable)
    )
  }

  func testSynthesizedGesturePoliciesMatchCommandContracts() {
    XCTAssertEqual(
      synthesizedGesturePolicy(.coordinateTap),
      SynthesizedGesturePolicy(
        keyboardPolicy: .never,
        fallbackPolicy: .xctestCoordinateAllowed
      )
    )
    XCTAssertEqual(
      synthesizedGesturePolicy(.scroll),
      SynthesizedGesturePolicy(
        keyboardPolicy: .requiredWhenAvailable,
        fallbackPolicy: .privateSynthesisRequired
      )
    )
    XCTAssertEqual(
      synthesizedGesturePolicy(.synthesizedDrag),
      SynthesizedGesturePolicy(
        keyboardPolicy: .requiredWhenAvailable,
        fallbackPolicy: .xctestCoordinateWhenAccessibilityAvailable
      )
    )
  }

  func testCoordinateTapTextInputProbeSkipsPenalizedXCTestChannel() {
    XCTAssertTrue(shouldProbeCoordinateTapTextInput(xCTestChannelPenalized: false))
    XCTAssertFalse(shouldProbeCoordinateTapTextInput(xCTestChannelPenalized: true))
  }

}
#endif
