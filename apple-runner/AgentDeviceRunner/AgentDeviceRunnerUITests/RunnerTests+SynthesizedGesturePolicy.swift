import XCTest

// Runner-local policy for AX-free/private synthesized iOS gestures.
//
// This policy is intentionally separate from the TS interaction guarantee matrix:
// ADR 0011 models element-targeting guarantees, while this module models command
// paths that must keep scroll/drag/sequence usable when XCTest AX is unhealthy.
//
// Manifest: contracts/fixtures/synthesized-gesture-policy.json

enum RunnerAccessibilityHealth: String, Equatable {
  case unknown
  case healthy
  case unavailable
}

enum SynthesizedCoordinateFrameSource: String, Equatable {
  case provided
  case appFrame
  case fallbackBounds
  case screenshot
}

enum SynthesizedKeyboardPolicy: String, Equatable, Hashable {
  case never
  case whenAccessibilityHealthy

  func allowsProbe(accessibilityHealth: RunnerAccessibilityHealth) -> Bool {
    switch self {
    case .never:
      return false
    case .whenAccessibilityHealthy:
      return accessibilityHealth == .healthy
    }
  }
}

enum SynthesizedFallbackPolicy: String, Equatable, Hashable {
  case privateSynthesisRequired
  case xctestCoordinateWhenAccessibilityHealthy
  case xctestCoordinateAllowed

  func allowsXCTestCoordinateFallback(accessibilityHealth: RunnerAccessibilityHealth) -> Bool {
    switch self {
    case .privateSynthesisRequired:
      return false
    case .xctestCoordinateWhenAccessibilityHealthy:
      return accessibilityHealth == .healthy
    case .xctestCoordinateAllowed:
      return true
    }
  }
}

enum SynthesizedGesturePolicyKind: String, Equatable, Hashable {
  case coordinateTap
  case scroll
  case synthesizedDrag
  case sequenceSynthesizedTap
  case sequenceSynthesizedDrag
}

struct SynthesizedGesturePolicy: Equatable, Hashable {
  let keyboardPolicy: SynthesizedKeyboardPolicy
  let fallbackPolicy: SynthesizedFallbackPolicy
}

struct SynthesizedCoordinateContext {
  let referenceFrame: CGRect
  let frameSource: SynthesizedCoordinateFrameSource
  let keyboardPolicy: SynthesizedKeyboardPolicy
  let fallbackPolicy: SynthesizedFallbackPolicy
  let accessibilityHealth: RunnerAccessibilityHealth

  func withReferenceFrame(_ frame: CGRect) -> SynthesizedCoordinateContext {
    SynthesizedCoordinateContext(
      referenceFrame: frame,
      frameSource: frameSource,
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
  case .synthesizedDrag, .sequenceSynthesizedTap, .sequenceSynthesizedDrag:
    return SynthesizedGesturePolicy(
      keyboardPolicy: .whenAccessibilityHealthy,
      fallbackPolicy: .xctestCoordinateWhenAccessibilityHealthy
    )
  }
}

func synthesizedGesturePolicyKind(for command: Command) -> SynthesizedGesturePolicyKind? {
  switch command.command {
  case .tap:
    return command.synthesized == true && command.x != nil && command.y != nil
      ? .coordinateTap
      : nil
  case .drag:
    return command.synthesized == true ? .synthesizedDrag : nil
  case .scroll:
    return .scroll
  default:
    return nil
  }
}

func synthesizedGesturePolicyKind(for step: SequenceStep) -> SynthesizedGesturePolicyKind? {
  guard step.synthesized == true else { return nil }
  switch step.kind {
  case "tap":
    return .sequenceSynthesizedTap
  case "drag":
    return .sequenceSynthesizedDrag
  default:
    return nil
  }
}

func synthesizedGesturePolicyKinds(for steps: [SequenceStep]) -> [SynthesizedGesturePolicyKind] {
  var seen: Set<SynthesizedGesturePolicyKind> = []
  var kinds: [SynthesizedGesturePolicyKind] = []
  for step in steps {
    guard let kind = synthesizedGesturePolicyKind(for: step), seen.insert(kind).inserted else {
      continue
    }
    kinds.append(kind)
  }
  return kinds
}

extension RunnerTests {
  func synthesizedCoordinateContexts(
    app: XCUIApplication,
    policyKinds: [SynthesizedGesturePolicyKind]
  ) -> [SynthesizedGesturePolicyKind: SynthesizedCoordinateContext] {
    var contexts: [SynthesizedGesturePolicyKind: SynthesizedCoordinateContext] = [:]
    var contextByPolicy: [SynthesizedGesturePolicy: SynthesizedCoordinateContext] = [:]
    for kind in policyKinds {
      let policy = synthesizedGesturePolicy(kind)
      if let existing = contextByPolicy[policy] {
        contexts[kind] = existing
        continue
      }
      guard let context = synthesizedCoordinateContext(app: app, policy: policy) else { continue }
      contexts[kind] = context
      contextByPolicy[policy] = context
    }
    return contexts
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
      "AGENT_DEVICE_RUNNER_SYNTHESIZED_GESTURE_POLICY kind=%@ axHealth=%@ frameSource=%@ keyboardPolicy=%@ fallbackPolicy=%@ fallbackAllowed=%@ fallbackAttempted=%@",
      kind.rawValue,
      context.accessibilityHealth.rawValue,
      context.frameSource.rawValue,
      context.keyboardPolicy.rawValue,
      context.fallbackPolicy.rawValue,
      context.allowsXCTestCoordinateFallback.description,
      fallbackAttempted.description
    )
#endif
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct SynthesizedGesturePolicyManifest: Decodable {
  struct Path: Decodable {
    let pathId: String
    let policyKind: String
    let keyboardPolicy: String
    let fallbackPolicy: String
  }

  let paths: [Path]
}

extension RunnerTests {
  func testSynthesizedGesturePolicyResolverMatchesManifest() throws {
    let manifestURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // apple-runner
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("synthesized-gesture-policy.json")
    let data = try Data(contentsOf: manifestURL)
    let manifest = try JSONDecoder().decode(SynthesizedGesturePolicyManifest.self, from: data)
    XCTAssertEqual(
      Set(manifest.paths.map(\.policyKind)),
      Set([
        SynthesizedGesturePolicyKind.coordinateTap.rawValue,
        SynthesizedGesturePolicyKind.scroll.rawValue,
        SynthesizedGesturePolicyKind.synthesizedDrag.rawValue,
        SynthesizedGesturePolicyKind.sequenceSynthesizedTap.rawValue,
        SynthesizedGesturePolicyKind.sequenceSynthesizedDrag.rawValue,
      ])
    )

    for path in manifest.paths {
      let kind = try XCTUnwrap(
        SynthesizedGesturePolicyKind(rawValue: path.policyKind),
        "\(path.pathId) has unknown policy kind \(path.policyKind)"
      )
      let keyboardPolicy = try XCTUnwrap(
        SynthesizedKeyboardPolicy(rawValue: path.keyboardPolicy),
        "\(path.pathId) has unknown keyboard policy \(path.keyboardPolicy)"
      )
      let fallbackPolicy = try XCTUnwrap(
        SynthesizedFallbackPolicy(rawValue: path.fallbackPolicy),
        "\(path.pathId) has unknown fallback policy \(path.fallbackPolicy)"
      )
      let policy = synthesizedGesturePolicy(kind)

      XCTAssertEqual(policy.keyboardPolicy, keyboardPolicy, path.pathId)
      XCTAssertEqual(policy.fallbackPolicy, fallbackPolicy, path.pathId)
    }
  }

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

  func testSynthesizedDragCoordinateFallbackRequiresHealthyAccessibility() {
    XCTAssertTrue(
      SynthesizedFallbackPolicy.xctestCoordinateWhenAccessibilityHealthy
        .allowsXCTestCoordinateFallback(accessibilityHealth: .healthy)
    )
    XCTAssertFalse(
      SynthesizedFallbackPolicy.xctestCoordinateWhenAccessibilityHealthy
        .allowsXCTestCoordinateFallback(accessibilityHealth: .unavailable)
    )
    XCTAssertFalse(
      SynthesizedFallbackPolicy.xctestCoordinateWhenAccessibilityHealthy
        .allowsXCTestCoordinateFallback(accessibilityHealth: .unknown)
    )
  }

  func testSynthesizedGesturePolicyKindMapsCommandPaths() throws {
    XCTAssertEqual(
      synthesizedGesturePolicyKind(for: try decodedSynthesizedGesturePolicyCommand(#"{"command":"scroll","direction":"down"}"#)),
      .scroll
    )
    XCTAssertEqual(
      synthesizedGesturePolicyKind(
        for: try decodedSynthesizedGesturePolicyCommand(
          #"{"command":"drag","x":1,"y":2,"x2":3,"y2":4,"synthesized":true}"#
        )
      ),
      .synthesizedDrag
    )
    XCTAssertNil(
      synthesizedGesturePolicyKind(
        for: try decodedSynthesizedGesturePolicyCommand(#"{"command":"drag","x":1,"y":2,"x2":3,"y2":4}"#)
      )
    )
    XCTAssertEqual(
      synthesizedGesturePolicyKind(
        for: try decodedSynthesizedGesturePolicyCommand(#"{"command":"tap","x":1,"y":2,"synthesized":true}"#)
      ),
      .coordinateTap
    )
    XCTAssertNil(
      synthesizedGesturePolicyKind(
        for: try decodedSynthesizedGesturePolicyCommand(
          #"{"command":"tap","selectorKey":"text","selectorValue":"Done","synthesized":true}"#
        )
      )
    )
  }

  private func decodedSynthesizedGesturePolicyCommand(_ json: String) throws -> Command {
    try JSONDecoder().decode(Command.self, from: Data(json.utf8))
  }
}
#endif
