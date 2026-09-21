import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testSynthesizedDispatchInvertsCaptureOnEveryInterfaceOrientation() {
    let frames = [
      CGRect(x: 0, y: 0, width: 430, height: 932),
      CGRect(x: 0, y: 0, width: 951, height: 669),
    ]
    for frame in frames {
      for orientation in [
        RunnerInterfaceOrientation.portrait,
        RunnerInterfaceOrientation.portraitUpsideDown,
        RunnerInterfaceOrientation.landscapeLeft,
        RunnerInterfaceOrientation.landscapeRight,
      ] {
        let corners = [
          CGPoint(x: frame.minX + 1, y: frame.minY + 1),
          CGPoint(x: frame.midX, y: frame.midY),
          CGPoint(x: frame.maxX - 2, y: frame.maxY - 3),
        ]
        for displayed in corners {
          let captured = CoordinateSpaceRotation.oriented(
            point: displayed,
            in: frame,
            interfaceOrientation: orientation
          )
          let dispatched = CoordinateSpaceRotation.native(
            point: captured,
            in: frame,
            interfaceOrientation: orientation
          )
          XCTAssertEqual(dispatched.x, displayed.x, accuracy: 0.001, "orientation \(orientation)")
          XCTAssertEqual(dispatched.y, displayed.y, accuracy: 0.001, "orientation \(orientation)")
        }
      }
    }
  }

  func testPlannedMultiTouchGestureAcceptsMatchingInBoundsTrajectories() throws {
    let plan = try JSONDecoder().decode(
      RunnerGesturePlan.self,
      from: Data(
        #"{"topology":"two","intent":"pan","durationMs":32,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":80,"y":80}},{"offsetMs":16,"point":{"x":90,"y":85}},{"offsetMs":32,"point":{"x":100,"y":90}}]},{"pointerId":1,"samples":[{"offsetMs":0,"point":{"x":80,"y":120}},{"offsetMs":16,"point":{"x":90,"y":125}},{"offsetMs":32,"point":{"x":100,"y":130}}]}]}"#.utf8
      )
    )

    XCTAssertNil(plannedGestureValidationError(plan))
    XCTAssertEqual(plannedGestureExecution(for: plan), .sampled)
  }

  func testPlannedMultiTouchGestureRejectsMismatchedOffsets() throws {
    let plan = try JSONDecoder().decode(
      RunnerGesturePlan.self,
      from: Data(
        #"{"topology":"two","intent":"transform","durationMs":32,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":80,"y":80}},{"offsetMs":32,"point":{"x":100,"y":90}}]},{"pointerId":1,"samples":[{"offsetMs":0,"point":{"x":80,"y":120}},{"offsetMs":31,"point":{"x":100,"y":130}}]}]}"#.utf8
      )
    )

    XCTAssertEqual(
      plannedGestureValidationError(plan),
      "planned pointer sample offsets must match and strictly increase"
    )
  }

  func testSinglePointerFlingUsesFastSwipeExecution() throws {
    let plan = try JSONDecoder().decode(
      RunnerGesturePlan.self,
      from: Data(
        #"{"topology":"single","intent":"fling","executionProfile":"endpoint-hold","durationMs":100,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":160,"y":150}},{"offsetMs":100,"point":{"x":40,"y":150}}]}]}"#.utf8
      )
    )

    XCTAssertEqual(plannedGestureExecution(for: plan), .fastSwipe)
  }

  func testSinglePointerTimedPanUsesSampledExecution() throws {
    let plan = try JSONDecoder().decode(
      RunnerGesturePlan.self,
      from: Data(
        #"{"topology":"single","intent":"pan","executionProfile":"timed-pan","durationMs":500,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":160,"y":150}},{"offsetMs":250,"point":{"x":100,"y":150}},{"offsetMs":500,"point":{"x":40,"y":150}}]}]}"#.utf8
      )
    )

    XCTAssertEqual(plannedGestureExecution(for: plan), .sampled)
  }

  func testSinglePointerEndpointHoldUsesFastSwipeExecution() throws {
    let plan = try JSONDecoder().decode(
      RunnerGesturePlan.self,
      from: Data(
        #"{"topology":"single","intent":"pan","executionProfile":"endpoint-hold","durationMs":500,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":160,"y":150}},{"offsetMs":500,"point":{"x":40,"y":150}}]}]}"#.utf8
      )
    )

    XCTAssertNil(plannedGestureValidationError(plan))
    XCTAssertEqual(plannedGestureExecution(for: plan), .fastSwipe)
  }

  func testSinglePointerGestureRejectsMissingExecutionProfile() throws {
    let plan = try JSONDecoder().decode(
      RunnerGesturePlan.self,
      from: Data(
        #"{"topology":"single","intent":"pan","durationMs":500,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":160,"y":150}},{"offsetMs":500,"point":{"x":40,"y":150}}]}]}"#.utf8
      )
    )

    XCTAssertEqual(
      plannedGestureValidationError(plan),
      "single-pointer gesture requires a supported execution profile"
    )
  }

}
#endif
