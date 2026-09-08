import XCTest

#if os(iOS)
extension RunnerTests {
  func issue84PublicXCTestDrag(app: XCUIApplication, plan: RunnerGesturePlan) -> RunnerInteractionOutcome {
    let samples = plan.pointers[0].samples
    guard let first = samples.first, let last = samples.last,
      let departure = samples.firstIndex(where: {
        $0.point.x != first.point.x || $0.point.y != first.point.y
      }), departure > 0,
      let arrival = samples.firstIndex(where: {
        $0.point.x == last.point.x && $0.point.y == last.point.y
      }), arrival >= departure
    else {
      return .unsupported(message: "ISSUE84_PUBLIC_DRAG requires a held straight drag", hint: nil)
    }
    let sourceHold = samples[departure - 1].offsetMs / 1000
    let movement = (samples[arrival].offsetMs - samples[departure - 1].offsetMs) / 1000
    let destinationHold = (plan.durationMs - samples[arrival].offsetMs) / 1000
    guard movement > 0 else {
      return .unsupported(message: "ISSUE84_PUBLIC_DRAG requires positive movement time", hint: nil)
    }
    let anchor = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    let origin = anchor.screenPoint
    let start = anchor.withOffset(CGVector(dx: first.point.x - origin.x, dy: first.point.y - origin.y))
    let end = anchor.withOffset(CGVector(dx: last.point.x - origin.x, dy: last.point.y - origin.y))
    let velocity = hypot(last.point.x - first.point.x, last.point.y - first.point.y) / movement
    NSLog("ISSUE84_PUBLIC_DRAG sourceHold=%.3f movement=%.3f destinationHold=%.3f velocity=%.3f",
          sourceHold, movement, destinationHold, velocity)
    start.press(
      forDuration: sourceHold,
      thenDragTo: end,
      withVelocity: XCUIGestureVelocity(rawValue: velocity),
      thenHoldForDuration: destinationHold
    )
    NSLog("ISSUE84_PUBLIC_DRAG completed")
    return .performed
  }
}
#endif
