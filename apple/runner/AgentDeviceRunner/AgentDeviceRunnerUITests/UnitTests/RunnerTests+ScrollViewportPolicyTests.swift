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

  /// A clipped landscape band shortens the frame, and `CoordinateSpaceRotation.native(point:)` derives a
  /// `landscapeRight` native x from the frame's HEIGHT. Rotating inside the band therefore moves the
  /// dispatched path sideways by exactly what the keyboard took, off the lane the plan was built for,
  /// so the plan band and the coordinate basis stay separate values through dispatch (#2500).
  func testScrollViewportDispatchKeepsTheUnclippedFrameAsItsCoordinateRotationBasis() throws {
    let viewport = CGRect(x: 0, y: 0, width: 1210, height: 834)
    let keyboard = CGRect(x: 0, y: 588, width: 1210, height: 246)
    let clip = ScrollViewportPolicy.clip(viewport: viewport, keyboard: keyboard)
    guard case .avoided(let band, let keyboardMinY) = clip else {
      return XCTFail("expected a landscape keyboard to be avoided, got \(clip)")
    }
    XCTAssertEqual(band.height, 576)

    guard case .gesture(let gesture) = ScrollViewportPolicy.frames(
      referenceFrame: viewport,
      clip: clip
    ).gestureDispatch(direction: .up, amount: nil, pixels: nil) else {
      return XCTFail("expected a gesture inside the clipped band")
    }
    XCTAssertEqual(gesture.planFrame, band)
    XCTAssertEqual(gesture.keyboardMinY, keyboardMinY)
    XCTAssertEqual(gesture.coordinateFrame, viewport, "the rotation basis must survive the clip")
    XCTAssertLessThanOrEqual(
      max(gesture.plan.y1, gesture.plan.y2),
      keyboard.minY - ScrollViewportPolicy.accessoryAllowance,
      "a landscape swipe must stay clear of the keys"
    )

    let reported = gesture.attachingEvidence(
      to: Response(
        ok: true,
        data: DataPayload(referenceWidth: viewport.width, referenceHeight: viewport.height),
        error: nil
      )
    )
    XCTAssertEqual(
      reported.data?.referenceHeight,
      band.height,
      "the payload names the band the plan ran inside, not the synthesis frame"
    )
    XCTAssertEqual(reported.data?.referenceWidth, viewport.width)
    XCTAssertEqual(reported.data?.keyboardMinY, keyboardMinY)
    XCTAssertEqual(reported.data?.keyboardAvoided, true)

    let orientedStartY = gesture.planFrame.minY + gesture.plan.y1
    let dispatchedFromViewport = CoordinateSpaceRotation.native(
      point: CGPoint(x: gesture.planFrame.minX + gesture.plan.x1, y: orientedStartY),
      in: gesture.coordinateFrame,
      interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
    )
    let dispatchedFromBand = CoordinateSpaceRotation.native(
      point: CGPoint(x: gesture.planFrame.minX + gesture.plan.x1, y: orientedStartY),
      in: gesture.planFrame,
      interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
    )
    XCTAssertEqual(
      dispatchedFromViewport.x - dispatchedFromBand.x,
      viewport.height - band.height,
      accuracy: 0.001,
      "rotating inside the clipped band would shift native x by what the keyboard took"
    )
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
