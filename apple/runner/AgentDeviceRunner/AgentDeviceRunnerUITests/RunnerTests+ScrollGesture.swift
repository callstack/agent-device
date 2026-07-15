import XCTest

// Swift port of buildScrollGesturePlan from src/contracts/scroll-gesture.ts.
//
// This is a deliberate two-place invariant: the daemon keeps the TS implementation (for Android,
// recording, and reported-pixels), and the runner places the gesture with this Swift copy. The
// parity test vectors at the bottom of this file mirror src/contracts/scroll-gesture.test.ts —
// if you change the math in either language, update the other and both vector sets.
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
private let runnerDefaultEdgePaddingFraction = 0.05

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
extension RunnerTests {
  // Cross-language parity vectors mirroring src/contracts/scroll-gesture.test.ts. Keep these
  // in sync with the vitest vectors so the two buildScrollGesturePlan implementations cannot drift.

  func testRunnerScrollGesturePlanMapsRelativeAmount() throws {
    let plan = try XCTUnwrap(
      runnerScrollGesturePlan(
        direction: "down",
        amount: 0.5,
        pixels: nil,
        referenceWidth: 400,
        referenceHeight: 800
      )
    )
    XCTAssertEqual(plan.x1, 200)
    XCTAssertEqual(plan.y1, 600)
    XCTAssertEqual(plan.x2, 200)
    XCTAssertEqual(plan.y2, 200)
    XCTAssertEqual(plan.travelPixels, 400)
  }

  func testRunnerScrollGesturePlanPixelsDown() throws {
    // 300x600, down, pixels 120 -> (150,360)->(150,240), travel 120.
    let plan = try XCTUnwrap(
      runnerScrollGesturePlan(
        direction: "down",
        amount: nil,
        pixels: 120,
        referenceWidth: 300,
        referenceHeight: 600
      )
    )
    XCTAssertEqual(plan.x1, 150)
    XCTAssertEqual(plan.y1, 360)
    XCTAssertEqual(plan.x2, 150)
    XCTAssertEqual(plan.y2, 240)
    XCTAssertEqual(plan.travelPixels, 120)
  }

  func testRunnerScrollGesturePlanClampsAmountAboveOne() throws {
    // 400x800, down, amount 2 -> requested 1600 clamps to the safe band (720): (200,760)->(200,40).
    let plan = try XCTUnwrap(
      runnerScrollGesturePlan(
        direction: "down",
        amount: 2,
        pixels: nil,
        referenceWidth: 400,
        referenceHeight: 800
      )
    )
    XCTAssertEqual(plan.x1, 200)
    XCTAssertEqual(plan.y1, 760)
    XCTAssertEqual(plan.x2, 200)
    XCTAssertEqual(plan.y2, 40)
    XCTAssertEqual(plan.travelPixels, 720)
  }

  func testRunnerScrollGesturePlanClampsExplicitPixelsVertically() throws {
    // 400x800, down, pixels 1000 clamps travel to the safe band (720): (200,760)->(200,40).
    let plan = try XCTUnwrap(
      runnerScrollGesturePlan(
        direction: "down",
        amount: nil,
        pixels: 1000,
        referenceWidth: 400,
        referenceHeight: 800
      )
    )
    XCTAssertEqual(plan.x1, 200)
    XCTAssertEqual(plan.y1, 760)
    XCTAssertEqual(plan.x2, 200)
    XCTAssertEqual(plan.y2, 40)
    XCTAssertEqual(plan.travelPixels, 720)
  }

  func testRunnerScrollGesturePlanFloorsTinyFrames() throws {
    // 2x2, down, pixels 10 engages every max(1, ...) floor and the .5 rounding cases the two
    // ports must agree on (halfTravel 0.5 -> 1, center 1 from 2/2): (1,2)->(1,0), travel 1.
    let plan = try XCTUnwrap(
      runnerScrollGesturePlan(
        direction: "down",
        amount: nil,
        pixels: 10,
        referenceWidth: 2,
        referenceHeight: 2
      )
    )
    XCTAssertEqual(plan.x1, 1)
    XCTAssertEqual(plan.y1, 2)
    XCTAssertEqual(plan.x2, 1)
    XCTAssertEqual(plan.y2, 0)
    XCTAssertEqual(plan.travelPixels, 1)
  }

  func testRunnerScrollGesturePlanClampsToSafeBand() throws {
    // 300x600, right, pixels 500 clamps travel to the safe band (270).
    let plan = try XCTUnwrap(
      runnerScrollGesturePlan(
        direction: "right",
        amount: nil,
        pixels: 500,
        referenceWidth: 300,
        referenceHeight: 600
      )
    )
    XCTAssertEqual(plan.x1, 285)
    XCTAssertEqual(plan.x2, 15)
    XCTAssertEqual(plan.y1, 300)
    XCTAssertEqual(plan.y2, 300)
    XCTAssertEqual(plan.travelPixels, 270)
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
