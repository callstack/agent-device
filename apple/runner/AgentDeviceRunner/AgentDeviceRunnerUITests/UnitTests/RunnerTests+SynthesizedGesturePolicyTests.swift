import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
extension RunnerTests {
  @MainActor
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
    XCTAssertFalse(SynthesizedKeyboardPolicy.never.allowsProbe(accessibilityHealth: .healthy))
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

  func testOnlySynthesizedSequenceTapStepsTakeTheCoordinateTapPolicy() {
    XCTAssertEqual(synthesizedPolicyKind(forSequenceStep: sequenceStep("tap", synthesized: true)), .coordinateTap)
    XCTAssertNil(synthesizedPolicyKind(forSequenceStep: sequenceStep("tap", synthesized: nil)))
    XCTAssertNil(synthesizedPolicyKind(forSequenceStep: sequenceStep("doubleTap", synthesized: true)))
    XCTAssertNil(synthesizedPolicyKind(forSequenceStep: sequenceStep("longPress", synthesized: true)))
  }

  @MainActor
  func testFailedCoordinateTapSynthesisFallsBackToXCTestAtEveryAccessibilityHealth() {
    for health: RunnerAccessibilityHealth in [.unknown, .healthy, .unavailable] {
      mainOwned.accessibilityHealth = health
      for context in [nil, synthesizedGestureTestContext(accessibilityHealth: health)] {
        let label = "axHealth=\(health.rawValue) context=\(context == nil ? "unresolved" : "resolved")"
        let attempt = performSynthesizedGesture(
          app,
          kind: .coordinateTap,
          context: context,
          synthesize: failedSynthesis
        )
        XCTAssertEqual(synthesizedGestureRoute(attempt), "xctestFallback", label)
      }
    }
  }

  @MainActor
  func testSynthesizedGestureFallbackFollowsItsKindAndTheResolvedAccessibilityHealth() {
    mainOwned.accessibilityHealth = .healthy
    let unavailable = synthesizedGestureTestContext(accessibilityHealth: .unavailable)
    let unknown = synthesizedGestureTestContext(accessibilityHealth: .unknown)
    let cases: [(SynthesizedGesturePolicyKind, SynthesizedCoordinateContext?, String)] = [
      (.scroll, synthesizedGestureTestContext(accessibilityHealth: .healthy), "refused"),
      (.synthesizedDrag, unavailable, "refused"),
      (.synthesizedDrag, unknown, "xctestFallback"),
      (.coordinateTap, unavailable, "xctestFallback"),
    ]
    for (kind, context, expected) in cases {
      let attempt = performSynthesizedGesture(app, kind: kind, context: context, synthesize: failedSynthesis)
      XCTAssertEqual(synthesizedGestureRoute(attempt), expected, "kind=\(kind.rawValue)")
      switch attempt {
      case .xctestFallback(let message, let hint), .refused(_, let message, let hint):
        XCTAssertEqual(message, "forced private synthesis failure")
        XCTAssertEqual(hint, "forced hint")
      case .performed:
        break
      }
      let performed = performSynthesizedGesture(app, kind: kind, context: context) { .performed }
      XCTAssertEqual(synthesizedGestureRoute(performed), "performed", "kind=\(kind.rawValue)")
    }
  }

  private func failedSynthesis() -> RunnerInteractionOutcome {
    .unsupported(message: "forced private synthesis failure", hint: "forced hint")
  }

  private func synthesizedGestureRoute(_ attempt: SynthesizedGestureAttempt) -> String {
    switch attempt {
    case .performed: return "performed"
    case .xctestFallback: return "xctestFallback"
    case .refused: return "refused"
    }
  }

  private func synthesizedGestureTestContext(
    accessibilityHealth: RunnerAccessibilityHealth
  ) -> SynthesizedCoordinateContext {
    SynthesizedCoordinateContext(
      referenceFrame: CGRect(x: 0, y: 0, width: 390, height: 844),
      resolvedWindow: app.windows.firstMatch,
      keyboardPolicy: .never,
      accessibilityHealth: accessibilityHealth
    )
  }

  private func sequenceStep(_ kind: String, synthesized: Bool?) -> SequenceStep {
    SequenceStep(kind: kind, x: 10, y: 20, durationMs: nil, pauseMs: nil, synthesized: synthesized)
  }
}
#endif
