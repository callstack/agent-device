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
  /// The whole fallback decision: which gesture kind may take the call site's XCTest coordinate
  /// gesture, at each accessibility health.
  func testSynthesizedCoordinateFallbackFollowsItsKindAndAccessibilityHealth() {
    let cases: [(kind: SynthesizedGesturePolicyKind, health: RunnerAccessibilityHealth, allowed: Bool)] = [
      (.coordinateTap, .unknown, true),
      (.coordinateTap, .healthy, true),
      (.coordinateTap, .unavailable, true),
      (.coordinateLongPress, .unknown, true),
      (.coordinateLongPress, .healthy, true),
      (.coordinateLongPress, .unavailable, false),
      (.scroll, .unknown, false),
      (.scroll, .healthy, false),
      (.scroll, .unavailable, false),
      (.synthesizedDrag, .unknown, true),
      (.synthesizedDrag, .healthy, true),
      (.synthesizedDrag, .unavailable, false),
    ]
    for testCase in cases {
      XCTAssertEqual(
        testCase.kind.allowsXCTestCoordinateFallback(accessibilityHealth: testCase.health),
        testCase.allowed,
        "kind=\(testCase.kind.rawValue) axHealth=\(testCase.health.rawValue)"
      )
    }
  }

  func testKeyboardProbeIsAllowedAtEveryAccessibilityHealthExceptUnavailable() {
    let cases: [(health: RunnerAccessibilityHealth, allowsProbe: Bool)] = [
      (.unknown, true),
      (.healthy, true),
      (.unavailable, false),
    ]
    for testCase in cases {
      let context = synthesizedGestureTestContext(accessibilityHealth: testCase.health)
      XCTAssertEqual(context.allowsKeyboardProbe, testCase.allowsProbe, "axHealth=\(testCase.health.rawValue)")
    }
  }

  func testCoordinateTapTextInputProbeSkipsPenalizedXCTestChannel() {
    XCTAssertTrue(shouldProbeCoordinateTapTextInput(xCTestChannelPenalized: false, evidence: nil, point: nil, targetBundleId: nil))
    XCTAssertFalse(shouldProbeCoordinateTapTextInput(xCTestChannelPenalized: true, evidence: nil, point: nil, targetBundleId: nil))
  }

  func testOnlySynthesizedSequenceTapStepsTakeTheCoordinateTapPolicy() {
    XCTAssertEqual(synthesizedPolicyKind(forSequenceStep: sequenceStep("tap", synthesized: true)), .coordinateTap)
    XCTAssertNil(synthesizedPolicyKind(forSequenceStep: sequenceStep("tap", synthesized: nil)))
    XCTAssertNil(synthesizedPolicyKind(forSequenceStep: sequenceStep("doubleTap", synthesized: true)))
  }

  func testSequenceLongPressStepsTakeTheLongPressPolicyWithoutARequestFlag() {
    for synthesized in [nil, true] as [Bool?] {
#if os(iOS)
      XCTAssertEqual(
        synthesizedPolicyKind(forSequenceStep: sequenceStep("longPress", synthesized: synthesized)),
        .coordinateLongPress
      )
#else
      XCTAssertNil(synthesizedPolicyKind(forSequenceStep: sequenceStep("longPress", synthesized: synthesized)))
#endif
    }
  }

  @MainActor
  func testCoordinateTapThatWasNotDispatchedDoesNotFallBackToXCTest() {
    for health: RunnerAccessibilityHealth in [.unknown, .healthy, .unavailable] {
      mainOwned.accessibilityHealth = health
      for context in [nil, synthesizedGestureTestContext(accessibilityHealth: health)] {
        let attempt = performSynthesizedGesture(app, kind: .coordinateTap, context: context) { nil }
        XCTAssertEqual(synthesizedGestureRoute(attempt), "refused", "axHealth=\(health.rawValue)")
      }
    }
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
      (.coordinateLongPress, unavailable, "refused"),
      (.coordinateLongPress, unknown, "xctestFallback"),
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
      accessibilityHealth: accessibilityHealth
    )
  }

  private func sequenceStep(_ kind: String, synthesized: Bool?) -> SequenceStep {
    SequenceStep(kind: kind, x: 10, y: 20, durationMs: nil, pauseMs: nil, synthesized: synthesized)
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct CoordinateTapTextInputFixture: Decodable {
  let name: String
  let point: RunnerGesturePoint
  let dispatchPoint: RunnerGesturePoint?
  let activeBundleId: String
  let expectedEvidence: CoordinateTapTextInputEvidence?
  let probe: Bool
}

extension RunnerTests {
  func testCoordinateTapTextInputAdmissionMatchesGoldenTable() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let fixtures = try JSONDecoder().decode([CoordinateTapTextInputFixture].self, from:
      Data(contentsOf: root.appendingPathComponent("contracts/fixtures/coordinate-tap-text-input.json")))
    XCTAssertFalse(fixtures.isEmpty)
    for fixture in fixtures {
      let point = fixture.dispatchPoint ?? fixture.point
      XCTAssertEqual(shouldProbeCoordinateTapTextInput(
        xCTestChannelPenalized: false,
        evidence: fixture.expectedEvidence,
        point: CGPoint(x: point.x, y: point.y),
        targetBundleId: fixture.activeBundleId
      ), fixture.probe, fixture.name)
    }
    XCTAssertTrue(shouldProbeCoordinateTapTextInput(xCTestChannelPenalized: false, evidence: nil, point: nil, targetBundleId: nil), "raw coordinates keep probing")
  }
}
#endif
