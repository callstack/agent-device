import XCTest

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
      .deletingLastPathComponent() // UnitTests
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
