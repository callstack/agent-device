import XCTest

// Swift port of buildScrollGesturePlan from packages/contracts/src/scroll-gesture.ts.
//
// This is a deliberate two-place invariant: the daemon keeps the TS implementation (for Android,
// recording, and reported-pixels), and the runner places the gesture with this Swift copy. Both
// ports are asserted against the same table, contracts/fixtures/scroll-gesture.json (gated
// XCTest at the bottom of this file, vitest twin packages/contracts/src/scroll-gesture.test.ts) —
// if you change the math in either language, update the other and the table.
//
// All inputs here are positive (reference dims, travel, center), so Swift's `.rounded()`
// (half away from zero) matches JS `Math.round` (half up) on every value computed below.

struct RunnerScrollGesturePlan {
  let x1: Double
  let y1: Double
  let x2: Double
  let y2: Double
  let travelPixels: Double
}

private let runnerDefaultScrollAmount = 0.6
// Both constants are pinned by contracts/fixtures/scroll-gesture.json (`constants`). Scroll gestures
// stay out of the outer 10% of each axis so a saturated scroll never touches down inside the status
// bar / Dynamic Island band (#1781 A1).
private let runnerDefaultEdgePaddingFraction = 0.1

func runnerScrollGesturePlan(
  direction: String,
  amount: Double?,
  pixels: Double?,
  referenceWidth: Double,
  referenceHeight: Double
) -> RunnerScrollGesturePlan? {
  // Mirror the TS INVALID_ARGS contract: non-positive or non-finite amount/pixels are rejected
  // rather than clamped into a journaled 1px scroll. The daemon validates before sending, so
  // this only triggers for non-daemon wire clients.
  if let amount, !(amount.isFinite && amount > 0) { return nil }
  if let pixels, !(pixels.isFinite && pixels > 0) { return nil }
  let axisLength = (direction == "up" || direction == "down") ? referenceHeight : referenceWidth
  let requestedAmount = amount ?? runnerDefaultScrollAmount
  let requestedPixels: Double =
    pixels.map { max(1, $0.rounded()) } ?? (axisLength * requestedAmount).rounded()
  let edgePadding = max(1, (axisLength * runnerDefaultEdgePaddingFraction).rounded())
  let maxTravelPixels = max(1, axisLength - edgePadding * 2)
  let travelPixels = max(1, min(requestedPixels, maxTravelPixels))
  let halfTravel = (travelPixels / 2).rounded()
  let centerX = (referenceWidth / 2).rounded()
  let centerY = (referenceHeight / 2).rounded()

  func plan(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> RunnerScrollGesturePlan {
    RunnerScrollGesturePlan(x1: x1, y1: y1, x2: x2, y2: y2, travelPixels: travelPixels)
  }

  switch direction {
  case "up":
    return plan(centerX, centerY - halfTravel, centerX, centerY + halfTravel)
  case "down":
    return plan(centerX, centerY + halfTravel, centerX, centerY - halfTravel)
  case "left":
    return plan(centerX - halfTravel, centerY, centerX + halfTravel, centerY)
  case "right":
    return plan(centerX + halfTravel, centerY, centerX - halfTravel, centerY)
  default:
    return nil
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct ScrollGestureFixture: Decodable {
  struct Constants: Decodable {
    let defaultScrollAmount: Double
    let defaultEdgePaddingFraction: Double
  }
  struct Expected: Decodable {
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
    let pixels: Double
  }
  struct Case: Decodable {
    let name: String
    let direction: String
    let amount: Double?
    let pixels: Double?
    let referenceWidth: Double
    let referenceHeight: Double
    let expected: Expected
  }

  let constants: Constants
  let cases: [Case]
}

extension RunnerTests {
  // Cross-language parity table: every case in contracts/fixtures/scroll-gesture.json must agree
  // with the vitest twin (packages/contracts/src/scroll-gesture.test.ts). Add vectors there,
  // never fork the math.
  private func loadScrollGestureFixture() throws -> ScrollGestureFixture {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("scroll-gesture.json")
    return try JSONDecoder().decode(ScrollGestureFixture.self, from: Data(contentsOf: fixtureURL))
  }

  func testRunnerScrollGesturePlanMatchesParityTable() throws {
    let fixture = try loadScrollGestureFixture()
    XCTAssertFalse(fixture.cases.isEmpty, "parity table must not be empty")
    for testCase in fixture.cases {
      let plan = try XCTUnwrap(
        runnerScrollGesturePlan(
          direction: testCase.direction,
          amount: testCase.amount,
          pixels: testCase.pixels,
          referenceWidth: testCase.referenceWidth,
          referenceHeight: testCase.referenceHeight
        ),
        testCase.name
      )
      XCTAssertEqual(plan.x1, testCase.expected.x1, testCase.name)
      XCTAssertEqual(plan.y1, testCase.expected.y1, testCase.name)
      XCTAssertEqual(plan.x2, testCase.expected.x2, testCase.name)
      XCTAssertEqual(plan.y2, testCase.expected.y2, testCase.name)
      XCTAssertEqual(plan.travelPixels, testCase.expected.pixels, testCase.name)
    }
  }

  // The planner constants are private on both sides; the table pins them behaviourally on a
  // 1000px axis where every rounding step is exact.
  func testRunnerScrollGesturePlanUsesParityTableConstants() throws {
    let constants = try loadScrollGestureFixture().constants
    let defaulted = try XCTUnwrap(
      runnerScrollGesturePlan(
        direction: "down", amount: nil, pixels: nil, referenceWidth: 1000, referenceHeight: 1000
      )
    )
    XCTAssertEqual(defaulted.travelPixels, 1000 * constants.defaultScrollAmount)
    let saturated = try XCTUnwrap(
      runnerScrollGesturePlan(
        direction: "down", amount: 10, pixels: nil, referenceWidth: 1000, referenceHeight: 1000
      )
    )
    XCTAssertEqual(
      saturated.travelPixels, 1000 - 2 * 1000 * constants.defaultEdgePaddingFraction)
  }

  func testRunnerScrollGesturePlanRejectsUnknownDirection() {
    XCTAssertNil(
      runnerScrollGesturePlan(
        direction: "sideways",
        amount: nil,
        pixels: 100,
        referenceWidth: 300,
        referenceHeight: 600
      )
    )
  }

  func testRunnerScrollGesturePlanRejectsInvalidAmountAndPixels() {
    XCTAssertNil(
      runnerScrollGesturePlan(
        direction: "down",
        amount: 0,
        pixels: nil,
        referenceWidth: 300,
        referenceHeight: 600
      )
    )
    XCTAssertNil(
      runnerScrollGesturePlan(
        direction: "down",
        amount: nil,
        pixels: -10,
        referenceWidth: 300,
        referenceHeight: 600
      )
    )
    XCTAssertNil(
      runnerScrollGesturePlan(
        direction: "down",
        amount: .infinity,
        pixels: nil,
        referenceWidth: 300,
        referenceHeight: 600
      )
    )
  }
}
#endif
