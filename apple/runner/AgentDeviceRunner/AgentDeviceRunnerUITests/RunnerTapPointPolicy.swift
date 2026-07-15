import XCTest

// The tap-point rule the runner shares with the TS runtime (ADR 0011 Layer 2).
//
// RULE: the tap point is the element frame's CENTER; a tap is allowed iff that
// center lies inside the window frame, edges inclusive. An empty or invalid
// window frame fails open (allowed): resolving the best available frame is the
// impure caller's job (onScreenWindowFrame / app.frame), and the policy must
// not turn a missing frame into a refusal.
//
// This is pure geometry on purpose — no XCUIElement — so the exact decision
// can be proven against the golden fixture table shared with the TS twin:
//   table:   contracts/fixtures/tap-point-policy.json
//   TS twin: src/snapshot/mobile-snapshot-semantics.ts#isTapPointInsideViewport
//   TS test: src/snapshot/__tests__/tap-point-policy-parity.test.ts
// Drift on either side turns CI red without needing a simulator.
enum TapPointPolicy {
  static func isAllowed(elementFrame: CGRect, windowFrame: CGRect) -> Bool {
    if windowFrame.isNull || windowFrame.isEmpty || windowFrame.isInfinite {
      return true
    }
    let centerX = elementFrame.midX
    let centerY = elementFrame.midY
    return centerX >= windowFrame.minX && centerX <= windowFrame.maxX
      && centerY >= windowFrame.minY && centerY <= windowFrame.maxY
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct TapPointPolicyFixture: Decodable {
  struct Frame: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var cgRect: CGRect {
      CGRect(x: x, y: y, width: width, height: height)
    }
  }

  let name: String
  let elementFrame: Frame
  let windowFrame: Frame
  let allowed: Bool
}

extension RunnerTests {
  // Golden parity table (ADR 0011 Layer 2): every case in
  // contracts/fixtures/tap-point-policy.json must agree with the vitest twin
  // (tap-point-policy-parity.test.ts). Add cases there, never fork the rule.
  func testTapPointPolicyMatchesGoldenParityTable() throws {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("tap-point-policy.json")
    let data = try Data(contentsOf: fixtureURL)
    let cases = try JSONDecoder().decode([TapPointPolicyFixture].self, from: data)
    XCTAssertFalse(cases.isEmpty, "parity table must not be empty")
    for fixture in cases {
      XCTAssertEqual(
        TapPointPolicy.isAllowed(
          elementFrame: fixture.elementFrame.cgRect,
          windowFrame: fixture.windowFrame.cgRect
        ),
        fixture.allowed,
        fixture.name
      )
    }
  }
}
#endif
