import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct ScrollViewportPolicyFixture: Decodable {
  struct Frame: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var cgRect: CGRect {
      CGRect(x: x, y: y, width: width, height: height)
    }
  }

  struct Constants: Decodable {
    let minVisibleFraction: Double
    let accessoryAllowance: Double
  }

  struct Expected: Decodable {
    let kind: String
    let viewport: Frame?
    let keyboardMinY: Double?
    let visibleHeight: Double?
  }

  struct TestCase: Decodable {
    let name: String
    let viewport: Frame
    let keyboard: Frame
    let expected: Expected
  }

  let constants: Constants
  let cases: [TestCase]
}

extension RunnerTests {
  /// Golden parity table (#2500): every case in contracts/fixtures/scroll-keyboard-policy.json must
  /// agree with the vitest twin. Add cases there, never fork the rule.
  func testScrollViewportKeyboardClipMatchesGoldenParityTable() throws {
    let fixture = try loadScrollViewportPolicyFixture()
    XCTAssertFalse(fixture.cases.isEmpty, "parity table must not be empty")
    for testCase in fixture.cases {
      let clip = ScrollViewportPolicy.clip(
        viewport: testCase.viewport.cgRect,
        keyboard: testCase.keyboard.cgRect
      )
      switch testCase.expected.kind {
      case "unobstructed":
        XCTAssertEqual(clip, .unobstructed, testCase.name)
      case "avoided":
        let expectedFrame = try XCTUnwrap(testCase.expected.viewport, testCase.name).cgRect
        let expectedMinY = try XCTUnwrap(testCase.expected.keyboardMinY, testCase.name)
        XCTAssertEqual(
          clip,
          .avoided(frame: expectedFrame, keyboardMinY: expectedMinY),
          testCase.name
        )
      case "occluded":
        let expectedMinY = try XCTUnwrap(testCase.expected.keyboardMinY, testCase.name)
        let expectedVisibleHeight = try XCTUnwrap(testCase.expected.visibleHeight, testCase.name)
        XCTAssertEqual(
          clip,
          .occluded(keyboardMinY: expectedMinY, visibleHeight: expectedVisibleHeight),
          testCase.name
        )
      default:
        XCTFail("unknown expected kind `\(testCase.expected.kind)` in \(testCase.name)")
      }
    }
  }

  /// The thresholds are the table's, not RunnerScrollViewportPolicy.swift's. The refusal reason
  /// and the runner code are each one side's own vocabulary: the reason is what the host publishes,
  /// the code is what this runner answers with, and neither is a shared clip constant.
  func testScrollViewportPolicyUsesParityTableConstants() throws {
    let constants = try loadScrollViewportPolicyFixture().constants
    XCTAssertEqual(constants.minVisibleFraction, ScrollViewportPolicy.minVisibleFraction)
    XCTAssertEqual(constants.accessoryAllowance, ScrollViewportPolicy.accessoryAllowance)
  }

  private func loadScrollViewportPolicyFixture() throws -> ScrollViewportPolicyFixture {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // UnitTests
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("scroll-keyboard-policy.json")
    return try JSONDecoder().decode(
      ScrollViewportPolicyFixture.self,
      from: Data(contentsOf: fixtureURL)
    )
  }
}
#endif
