import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

/// Stands in for XCTest on an app tree it cannot serialize (a React Native feed at accessibility
/// depth 62 or more): the windows query finds no window and every element frame, the application's
/// included, reads as null.
private final class RunnerUnserializableTreeStub: NSObject {
  /// Each element frame read costs XCTest's retries on such a tree, about 2 s each.
  static var frameReads = 0
  @objc var allElementsBoundByIndex: [XCUIElement] { [] }
  @objc var frame: CGRect {
    Self.frameReads += 1
    return .null
  }
}

/// Counts XCTest coordinate presses without performing them.
private final class RunnerCoordinatePressCounter: NSObject {
  static var presses = 0
  @objc(pressForDuration:)
  func press(forDuration duration: TimeInterval) {
    Self.presses += 1
  }
}

extension RunnerTests {
  /// Installs `RunnerUnserializableTreeStub` until the returned closure restores XCTest.
  private func simulateUnserializableAppTree() throws -> () -> Void {
    let swaps: [(Method?, Method?)] = [
      (class_getInstanceMethod(XCUIElementQuery.self, #selector(getter: XCUIElementQuery.allElementsBoundByIndex)),
       class_getInstanceMethod(RunnerUnserializableTreeStub.self, #selector(getter: RunnerUnserializableTreeStub.allElementsBoundByIndex))),
      (class_getInstanceMethod(XCUIElement.self, #selector(getter: XCUIElement.frame)),
       class_getInstanceMethod(RunnerUnserializableTreeStub.self, #selector(getter: RunnerUnserializableTreeStub.frame))),
      (class_getInstanceMethod(XCUICoordinate.self, #selector(XCUICoordinate.press(forDuration:))),
       class_getInstanceMethod(RunnerCoordinatePressCounter.self, #selector(RunnerCoordinatePressCounter.press(forDuration:)))),
    ]
    let resolved = try swaps.map { (try XCTUnwrap($0.0), try XCTUnwrap($0.1)) }
    let originals = resolved.map { target, stub in
      (target, method_setImplementation(target, method_getImplementation(stub)))
    }
    RunnerCoordinatePressCounter.presses = 0
    RunnerUnserializableTreeStub.frameReads = 0
    return {
      for (method, original) in originals.reversed() { method_setImplementation(method, original) }
    }
  }

  private var showsAppsOnlyFullScreen: Bool {
    UIDevice.current.userInterfaceIdiom == .phone && XCUIScreen.screens.count == 1
  }

  /// On a tree XCTest cannot serialize, XCTest's coordinate press reads an infinite app frame and
  /// raises an exception that ends the runner test. A long press needs no tree: on an iPhone with one
  /// screen it is synthesized on that screen, and anything else keeps the XCTest press.
  @MainActor
  func testLongPressOnAnUnserializableTreeIsSynthesizedOnTheSoleScreen() throws {
    app.launch()
    mainOwned.app = app
    mainOwned.accessibilityHealth = .healthy
    let restoreXCTest = try simulateUnserializableAppTree()
    defer {
      restoreXCTest()
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let longPress = try runnerCommandFixture(
      #"{"command":"longPress","commandId":"unserializable-long-press","x":40,"y":40,"durationMs":600}"#
    )
    let pressSeries = try runnerCommandFixture(
      #"{"command":"sequence","commandId":"unserializable-press-series","steps":[{"kind":"longPress","x":40,"y":40,"durationMs":600,"pauseMs":50},{"kind":"longPress","x":40,"y":40,"durationMs":600}]}"#
    )

    let longPressResponse = try executeOnMainPrepared(command: longPress, activeApp: app)
    let longPressCoordinatePresses = RunnerCoordinatePressCounter.presses
    let pressSeriesResponse = try executeOnMainPrepared(command: pressSeries, activeApp: app)

    XCTAssertTrue(longPressResponse.ok, String(describing: longPressResponse.error))
    XCTAssertEqual(longPressResponse.data?.message, "long pressed")
    XCTAssertTrue(pressSeriesResponse.ok, String(describing: pressSeriesResponse.error))
    if showsAppsOnlyFullScreen {
      XCTAssertEqual(longPressCoordinatePresses, 0)
      XCTAssertNil(longPressResponse.data?.gestureFallback)
      XCTAssertEqual(pressSeriesResponse.data?.completedSteps, 2)
      XCTAssertEqual(RunnerCoordinatePressCounter.presses, 0)
      XCTAssertEqual(RunnerUnserializableTreeStub.frameReads, 0)
      let steps = pressSeriesResponse.data?.sequenceResults ?? []
      XCTAssertEqual(steps.count, 2)
      let holds = [(longPressResponse.data?.gestureStartUptimeMs, longPressResponse.data?.gestureEndUptimeMs)]
        + steps.map { ($0.gestureStartUptimeMs, $0.gestureEndUptimeMs) }
      for (start, end) in holds {
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(end) - XCTUnwrap(start), 600)
      }
    } else {
      XCTAssertEqual(longPressCoordinatePresses, 1)
      XCTAssertEqual(longPressResponse.data?.gestureFallback, "xctest-coordinate-long-press")
      XCTAssertEqual(RunnerCoordinatePressCounter.presses, 3)
    }
  }

  /// A swipe asks for the gesture viewport before it plans its path. On a tree XCTest cannot
  /// serialize, an iPhone with one screen answers with that screen, the frame the planned gesture's
  /// record is routed to; anything else keeps requiring a window.
  @MainActor
  func testGestureViewportOnAnUnserializableTreeIsTheSoleScreen() throws {
    app.launch()
    mainOwned.app = app
    let restoreXCTest = try simulateUnserializableAppTree()
    defer {
      restoreXCTest()
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let command = try runnerCommandFixture(
      #"{"command":"gestureViewport","commandId":"unserializable-gesture-viewport"}"#
    )

    let response = try executeOnMainPrepared(command: command, activeApp: app)

    if showsAppsOnlyFullScreen {
      XCTAssertTrue(response.ok, String(describing: response.error))
      let screen = UIScreen.main.bounds
      XCTAssertEqual(response.data?.x, 0)
      XCTAssertEqual(response.data?.y, 0)
      XCTAssertEqual(response.data?.x2, Double(screen.width))
      XCTAssertEqual(response.data?.y2, Double(screen.height))
    } else {
      XCTAssertFalse(response.ok)
      XCTAssertEqual(response.error?.message, "Active app interaction viewport is unavailable")
    }
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testSoleScreenReferenceFrameLaysTheScreenInTheAppsOrientation() {
    let portrait = CGSize(width: 402, height: 874)
    for orientation in [RunnerInterfaceOrientation.portrait, RunnerInterfaceOrientation.portraitUpsideDown] {
      XCTAssertEqual(
        Self.soleScreenReferenceFrame(nativePortraitSize: portrait, interfaceOrientation: orientation),
        CGRect(x: 0, y: 0, width: 402, height: 874)
      )
    }
    for orientation in [RunnerInterfaceOrientation.landscapeLeft, RunnerInterfaceOrientation.landscapeRight] {
      XCTAssertEqual(
        Self.soleScreenReferenceFrame(nativePortraitSize: portrait, interfaceOrientation: orientation),
        CGRect(x: 0, y: 0, width: 874, height: 402)
      )
    }
  }

#if os(iOS)
  /// The sole-screen route is the boundary every window-less gesture crosses, so it decides the device
  /// rule itself: an iPhone with one screen names that screen, and an iPad refuses, because it can show
  /// the app in part of its screen. Run on both device families to cover both answers.
  func testSoleScreenDisplayIDIsNamedOnlyForAnIPhoneWithOneScreen() {
    var displayID: UInt = 0
    let refusal = RunnerResolveSoleScreenDisplayID(&displayID)
    if UIDevice.current.userInterfaceIdiom == .phone, XCUIScreen.screens.count == 1 {
      XCTAssertNil(refusal)
      XCTAssertNotEqual(displayID, 0)
    } else {
      XCTAssertNotNil(refusal)
      XCTAssertEqual(displayID, 0)
    }
  }
#endif

  func testSoleScreenReferenceFrameRefusesAnUnknownOrientationOrAnEmptyScreen() {
    XCTAssertNil(
      Self.soleScreenReferenceFrame(
        nativePortraitSize: CGSize(width: 402, height: 874),
        interfaceOrientation: RunnerInterfaceOrientation.unknown
      )
    )
    XCTAssertNil(
      Self.soleScreenReferenceFrame(
        nativePortraitSize: .zero,
        interfaceOrientation: RunnerInterfaceOrientation.portrait
      )
    )
  }

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
        #"{"topology":"multi","intent":"pan","durationMs":32,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":80,"y":80}},{"offsetMs":16,"point":{"x":90,"y":85}},{"offsetMs":32,"point":{"x":100,"y":90}}]},{"pointerId":1,"samples":[{"offsetMs":0,"point":{"x":80,"y":120}},{"offsetMs":16,"point":{"x":90,"y":125}},{"offsetMs":32,"point":{"x":100,"y":130}}]}]}"#.utf8
      )
    )

    XCTAssertNil(plannedGestureValidationError(plan))
    XCTAssertEqual(plannedGestureExecution(for: plan), .sampled)
  }

  func testPlannedMultiTouchGestureRejectsMismatchedOffsets() throws {
    let plan = try JSONDecoder().decode(
      RunnerGesturePlan.self,
      from: Data(
        #"{"topology":"multi","intent":"transform","durationMs":32,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":80,"y":80}},{"offsetMs":32,"point":{"x":100,"y":90}}]},{"pointerId":1,"samples":[{"offsetMs":0,"point":{"x":80,"y":120}},{"offsetMs":31,"point":{"x":100,"y":130}}]}]}"#.utf8
      )
    )

    XCTAssertEqual(
      plannedGestureValidationError(plan),
      "planned pointer sample offsets must match and strictly increase"
    )
  }

  func testPlannedTapAcceptsTwoToFiveStationaryContacts() throws {
    for count in [2, 5] {
      let plan = try decodedMultiContactPlan(intent: "tap", starts: tapStarts(count))
      XCTAssertNil(plannedGestureValidationError(plan), "\(count) contacts")
      XCTAssertEqual(plannedGestureExecution(for: plan), .sampled)
    }
  }

  func testPlannedTapRejectsOneOrSixContacts() throws {
    for count in [1, 6] {
      let plan = try decodedMultiContactPlan(intent: "tap", starts: tapStarts(count))
      XCTAssertEqual(
        plannedGestureValidationError(plan),
        "planned gesture pointer count does not match topology",
        "\(count) contacts"
      )
    }
  }

  func testPlannedTapRejectsMovingAndCoincidentContacts() throws {
    let moving = try decodedMultiContactPlan(
      intent: "tap", starts: tapStarts(3), lastPointerEndsAt: (x: 150, y: 150)
    )
    XCTAssertEqual(plannedGestureValidationError(moving), "planned tap contacts must not move")

    let coincident = try decodedMultiContactPlan(
      intent: "tap", starts: [(x: 40, y: 40), (x: 80, y: 40), (x: 40, y: 40)]
    )
    XCTAssertEqual(
      plannedGestureValidationError(coincident),
      "planned tap contacts must start on distinct points"
    )
  }

  func testPlannedPinchStillRequiresExactlyTwoContacts() throws {
    let plan = try decodedMultiContactPlan(intent: "pinch", starts: tapStarts(3))
    XCTAssertEqual(
      plannedGestureValidationError(plan),
      "planned gesture pointer count does not match topology"
    )
  }

  private func tapStarts(_ count: Int) -> [(x: Double, y: Double)] {
    (0..<count).map { index in (x: 20 + Double(index) * 30, y: 100) }
  }

  /// Stationary contacts held for 50 ms; `lastPointerEndsAt` moves the last contact's final sample.
  private func decodedMultiContactPlan(
    intent: String,
    starts: [(x: Double, y: Double)],
    lastPointerEndsAt: (x: Double, y: Double)? = nil
  ) throws -> RunnerGesturePlan {
    let pointers = starts.enumerated().map { index, start -> String in
      let end = index == starts.count - 1 ? lastPointerEndsAt ?? start : start
      return #"{"pointerId":\#(index),"samples":[{"offsetMs":0,"point":{"x":\#(start.x),"y":\#(start.y)}},{"offsetMs":50,"point":{"x":\#(end.x),"y":\#(end.y)}}]}"#
    }
    let json = #"{"topology":"multi","intent":"\#(intent)","durationMs":50,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[\#(pointers.joined(separator: ","))]}"#
    return try JSONDecoder().decode(RunnerGesturePlan.self, from: Data(json.utf8))
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
