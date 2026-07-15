import XCTest

// Runner-local policy for AX-free/private synthesized iOS gestures.
//
// This policy is intentionally separate from the TS interaction guarantee matrix:
// ADR 0011 models element-targeting guarantees, while this module models command
// paths that must keep scroll/drag/sequence usable when XCTest AX is unhealthy.

enum RunnerAccessibilityHealth: String, Equatable {
  case unknown
  case healthy
  case unavailable
}

enum SynthesizedKeyboardPolicy: String, Equatable, Hashable {
  case never
  case whenAccessibilityHealthy
  case requiredWhenAvailable

  func allowsProbe(accessibilityHealth: RunnerAccessibilityHealth) -> Bool {
    switch self {
    case .never:
      return false
    case .whenAccessibilityHealthy:
      return accessibilityHealth == .healthy
    case .requiredWhenAvailable:
      return accessibilityHealth != .unavailable
    }
  }
}

enum SynthesizedFallbackPolicy: String, Equatable, Hashable {
  case privateSynthesisRequired
  case xctestCoordinateWhenAccessibilityAvailable
  case xctestCoordinateAllowed

  func allowsXCTestCoordinateFallback(accessibilityHealth: RunnerAccessibilityHealth) -> Bool {
    switch self {
    case .privateSynthesisRequired:
      return false
    case .xctestCoordinateWhenAccessibilityAvailable:
      return accessibilityHealth != .unavailable
    case .xctestCoordinateAllowed:
      return true
    }
  }
}

enum SynthesizedGesturePolicyKind: String, Equatable, Hashable {
  case coordinateTap
  case scroll
  case synthesizedDrag
}

struct SynthesizedGesturePolicy: Equatable, Hashable {
  let keyboardPolicy: SynthesizedKeyboardPolicy
  let fallbackPolicy: SynthesizedFallbackPolicy
}

struct SynthesizedCoordinateContext {
  let referenceFrame: CGRect
  let keyboardPolicy: SynthesizedKeyboardPolicy
  let fallbackPolicy: SynthesizedFallbackPolicy
  let accessibilityHealth: RunnerAccessibilityHealth

  func withReferenceFrame(_ frame: CGRect) -> SynthesizedCoordinateContext {
    SynthesizedCoordinateContext(
      referenceFrame: frame,
      keyboardPolicy: keyboardPolicy,
      fallbackPolicy: fallbackPolicy,
      accessibilityHealth: accessibilityHealth
    )
  }

  var allowsXCTestCoordinateFallback: Bool {
    fallbackPolicy.allowsXCTestCoordinateFallback(accessibilityHealth: accessibilityHealth)
  }

  var allowsKeyboardProbe: Bool {
    keyboardPolicy.allowsProbe(accessibilityHealth: accessibilityHealth)
  }
}

func synthesizedGesturePolicy(_ kind: SynthesizedGesturePolicyKind) -> SynthesizedGesturePolicy {
  switch kind {
  case .coordinateTap:
    return SynthesizedGesturePolicy(
      keyboardPolicy: .never,
      fallbackPolicy: .xctestCoordinateAllowed
    )
  case .scroll:
    return SynthesizedGesturePolicy(
      keyboardPolicy: .whenAccessibilityHealthy,
      fallbackPolicy: .privateSynthesisRequired
    )
  case .synthesizedDrag:
    return SynthesizedGesturePolicy(
      keyboardPolicy: .requiredWhenAvailable,
      fallbackPolicy: .xctestCoordinateWhenAccessibilityAvailable
    )
  }
}

func sequenceHasSynthesizedCoordinateStep(_ steps: [SequenceStep]) -> Bool {
  steps.contains { step in
    step.synthesized == true && step.kind == "tap"
  }
}

extension RunnerTests {
  func synthesizedSequenceCoordinateContext(steps: [SequenceStep]) -> SynthesizedCoordinateContext? {
    guard sequenceHasSynthesizedCoordinateStep(steps) else { return nil }
    return synthesizedCoordinateContext(policy: synthesizedGesturePolicy(.synthesizedDrag))
  }

  func logSynthesizedGesturePolicyDecision(
    kind: SynthesizedGesturePolicyKind,
    context: SynthesizedCoordinateContext?,
    fallbackAttempted: Bool
  ) {
#if os(iOS)
    guard let context else {
      NSLog(
        "AGENT_DEVICE_RUNNER_SYNTHESIZED_GESTURE_POLICY kind=%@ context=unavailable fallbackAttempted=%@",
        kind.rawValue,
        fallbackAttempted.description
      )
      return
    }
    NSLog(
      "AGENT_DEVICE_RUNNER_SYNTHESIZED_GESTURE_POLICY kind=%@ axHealth=%@ frameSource=screenshot keyboardPolicy=%@ fallbackPolicy=%@ fallbackAllowed=%@ fallbackAttempted=%@",
      kind.rawValue,
      context.accessibilityHealth.rawValue,
      context.keyboardPolicy.rawValue,
      context.fallbackPolicy.rawValue,
      context.allowsXCTestCoordinateFallback.description,
      fallbackAttempted.description
    )
#endif
  }
}

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

  func testSynthesizedKeyboardPolicyKeepsUnknownDragProbeButNotUnknownScrollProbe() {
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
        keyboardPolicy: .whenAccessibilityHealthy,
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

}
#endif
