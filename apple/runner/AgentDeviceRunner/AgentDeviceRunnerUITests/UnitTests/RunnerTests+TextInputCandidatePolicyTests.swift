import CoreGraphics
import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testCoordinateTextInputCandidateMustBeEnabledAndContainTheTouchPoint() {
    let frame = CGRect(x: 10, y: 20, width: 100, height: 40)
    let point = CGPoint(x: 50, y: 40)

    XCTAssertTrue(
      isCoordinateTextInputCandidate(
        enabled: true,
        frame: frame,
        point: point
      )
    )
    XCTAssertFalse(
      isCoordinateTextInputCandidate(
        enabled: false,
        frame: frame,
        point: point
      )
    )
    XCTAssertFalse(
      isCoordinateTextInputCandidate(
        enabled: true,
        frame: frame,
        point: CGPoint(x: 200, y: 200)
      )
    )
  }
}
#endif
