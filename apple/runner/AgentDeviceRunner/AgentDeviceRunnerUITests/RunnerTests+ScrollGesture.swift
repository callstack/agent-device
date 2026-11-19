import XCTest

// Swift port of buildScrollGesturePlan from packages/contracts/src/scroll-gesture.ts.
//
// This is a deliberate two-place invariant: the daemon keeps the TS implementation (for Android,
// recording, and reported-pixels), and the runner places the gesture with this Swift copy. Both
// ports are asserted against the same table, contracts/fixtures/scroll-gesture.json (gated
// XCTest in UnitTests/RunnerTests+ScrollGestureTests.swift, vitest twin
// packages/contracts/src/scroll-gesture.test.ts) — if you change the math in either language,
// update the other and the table.
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

enum RunnerScrollDirection: String {
  case up
  case down
  case left
  case right

  var isVertical: Bool {
    self == .up || self == .down
  }
}

private let runnerDefaultScrollAmount = 0.6
private let runnerDefaultIosScrollAmount = 0.65
private let runnerDefaultIosScrollDurationMs = 400.0
let runnerDefaultDragDurationMs = 250.0
// The platform scroll defaults and planner constants are pinned by
// contracts/fixtures/scroll-gesture.json (`constants`). Scroll gestures stay out of the outer 10%
// of each axis so a saturated scroll never touches down inside the status bar / Dynamic Island band
// (#1781 A1).
private let runnerDefaultEdgePaddingFraction = 0.1

func runnerScrollGesturePlan(
  direction: RunnerScrollDirection,
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
  let axisLength = direction.isVertical ? referenceHeight : referenceWidth
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
  case .up:
    return plan(centerX, centerY - halfTravel, centerX, centerY + halfTravel)
  case .down:
    return plan(centerX, centerY + halfTravel, centerX, centerY - halfTravel)
  case .left:
    return plan(centerX - halfTravel, centerY, centerX + halfTravel, centerY)
  case .right:
    return plan(centerX + halfTravel, centerY, centerX - halfTravel, centerY)
  }
}

struct RunnerDragCommandDefaults {
  let scrollAmount: Double?
  let durationMs: Double
}

func runnerDragCommandDefaults(_ command: Command) -> RunnerDragCommandDefaults {
  if command.command == .scroll {
    return RunnerDragCommandDefaults(
      scrollAmount: command.pixels == nil ? (command.amount ?? runnerDefaultIosScrollAmount) : command.amount,
      durationMs: command.durationMs ?? runnerDefaultIosScrollDurationMs
    )
  }
  return RunnerDragCommandDefaults(
    scrollAmount: nil,
    durationMs: command.durationMs ?? runnerDefaultDragDurationMs
  )
}
