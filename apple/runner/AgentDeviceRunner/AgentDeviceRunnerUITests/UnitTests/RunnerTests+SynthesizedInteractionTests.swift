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

/// Answers like the runner process's `UIScreen` in iPad compatibility mode, which the generated runner
/// app (no launch screen) can run in: 768x1024 whatever the device (#4091). It replaces the getters a
/// runner-process screen read takes: `bounds`, and `nativeBounds` over `nativeScale`.
private final class RunnerCompatibilityModeScreenStub: NSObject {
  @objc var bounds: CGRect { CGRect(x: 0, y: 0, width: 768, height: 1024) }
  @objc var nativeBounds: CGRect { CGRect(x: 0, y: 0, width: 1536, height: 2048) }
  @objc var nativeScale: CGFloat { 2 }
}

/// Answers like an AXRuntime whose system application cannot be read, so the display size is unknown.
private final class RunnerUnreadableSystemApplicationStub: NSObject {
  @objc class func systemApplication() -> AnyObject? { nil }
}

extension RunnerTests {
  /// Installs `RunnerUnreadableSystemApplicationStub` on AXRuntime's `AXElement` until the returned
  /// closure restores it.
  private func simulateUnreadableSystemApplication() throws -> () -> Void {
    // The bridge loads AXRuntime on its first read.
    _ = RunnerSystemApplicationScreenSize()
    let element: AnyClass = try XCTUnwrap(NSClassFromString("AXElement"))
    let selector = NSSelectorFromString("systemApplication")
    let target = try XCTUnwrap(class_getClassMethod(element, selector))
    let stub = try XCTUnwrap(class_getClassMethod(RunnerUnreadableSystemApplicationStub.self, selector))
    let original = method_setImplementation(target, method_getImplementation(stub))
    return { method_setImplementation(target, original) }
  }

  /// Installs `RunnerCompatibilityModeScreenStub` until the returned closure restores UIKit.
  private func simulateCompatibilityModeScreen() throws -> () -> Void {
    let getters = [
      #selector(getter: UIScreen.bounds),
      #selector(getter: UIScreen.nativeBounds),
      #selector(getter: UIScreen.nativeScale),
    ]
    let resolved = try getters.map { getter in
      (
        try XCTUnwrap(class_getInstanceMethod(UIScreen.self, getter)),
        try XCTUnwrap(class_getInstanceMethod(RunnerCompatibilityModeScreenStub.self, getter))
      )
    }
    let originals = resolved.map { target, stub in
      (target, method_setImplementation(target, method_getImplementation(stub)))
    }
    return {
      for (method, original) in originals.reversed() { method_setImplementation(method, original) }
    }
  }

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

  /// On a tree XCTest cannot serialize, XCTest's coordinate press reads an infinite app frame and
  /// raises an exception that ends the runner test. A long press needs no tree: when the sole-screen
  /// route is open for the app it is synthesized on that screen, and anything else keeps the XCTest
  /// press.
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
    if soleScreenRouteIsOpen(for: app) {
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
  /// serialize, the app whose sole screen it provably fills answers with that screen, the frame the
  /// planned gesture's record is routed to; anything else keeps requiring a window.
  @MainActor
  func testGestureViewportOnAnUnserializableTreeIsTheSoleScreen() throws {
    app.launch()
    mainOwned.app = app
    let appFrame = app.frame
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

    if soleScreenRouteIsOpen(for: app) {
      XCTAssertTrue(response.ok, String(describing: response.error))
      XCTAssertEqual(response.data?.x, 0)
      XCTAssertEqual(response.data?.y, 0)
      XCTAssertEqual(try XCTUnwrap(response.data?.x2), Double(appFrame.width), accuracy: 0.5)
      XCTAssertEqual(try XCTUnwrap(response.data?.y2), Double(appFrame.height), accuracy: 0.5)
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
        Self.soleScreenReferenceFrame(portraitSize: portrait, interfaceOrientation: orientation),
        CGRect(x: 0, y: 0, width: 402, height: 874)
      )
    }
    for orientation in [RunnerInterfaceOrientation.landscapeLeft, RunnerInterfaceOrientation.landscapeRight] {
      XCTAssertEqual(
        Self.soleScreenReferenceFrame(portraitSize: portrait, interfaceOrientation: orientation),
        CGRect(x: 0, y: 0, width: 874, height: 402)
      )
    }
  }

#if os(iOS)
  /// The launched runner host app fills its simulator's only screen, so its window-less gestures
  /// route through that screen on either family. A windowed iPad app is refused the same route — that
  /// case needs an iPad set to Windowed Apps, which the nightly lane does not run; what the rule
  /// refuses here is the closest executable negative: on an iPad, an app that is not the
  /// accessibility primary app has no screen to fill, so naming one would book a tap on another
  /// app's frame. An iPhone keeps the rule by idiom, as before this change.
  @MainActor
  func testSoleScreenDisplayIDIsNamedOnlyForAnAppThatFillsItsScreen() throws {
    app.launch()
    mainOwned.app = app
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(
      soleScreenRouteIsOpen(for: app),
      "the foreground app fills the simulator's only screen on both families"
    )
    guard UIDevice.current.userInterfaceIdiom != .phone else {
      return
    }

    var screen: AnyObject?
    var displayID: UInt = 0
    let refusal = RunnerResolveSoleScreen(springboard, &screen, &displayID)
    XCTAssertNotNil(refusal, "an iPad app that does not own the screen names no sole screen for its taps")
    XCTAssertNil(screen)
    XCTAssertEqual(displayID, 0)
  }

  /// #3899: a synthesized turn swaps the display's side lengths, never a placed window's smaller box.
  /// #4091: the display is the one the launched host app fills, not the runner process's own
  /// `UIScreen`, which the generated runner app (no launch screen) reads in compatibility mode.
  @MainActor
  func testSynthesizedRotationFrameIsTheDisplayNotAPlacedWindow() throws {
    try XCTSkipUnless(XCUIScreen.screens.count == 1, "a multi-screen host keeps its panel's window box")
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    try XCTSkipUnless(soleScreenRouteIsOpen(for: app), "the host app's frame is the display only while it fills it")
    let appFrame = app.frame
    let restoreUIKit = try simulateCompatibilityModeScreen()
    defer { restoreUIKit() }
    let placedWindow = CGRect(x: 224, y: 207, width: 386, height: 682)
    let screen = CGSize(
      width: min(appFrame.width, appFrame.height),
      height: max(appFrame.width, appFrame.height)
    )
    XCTAssertNotEqual(screen, CGSize(width: 768, height: 1024), "the host app must not fill a 768x1024 screen")
    // Two AX readers of one screen; the fills-screen proof ties them within 0.5 pt.
    let expectations = [
      (RunnerInterfaceOrientation.portrait, screen),
      (RunnerInterfaceOrientation.landscapeRight, CGSize(width: screen.height, height: screen.width)),
    ]
    for (orientation, expected) in expectations {
      let frame = try XCTUnwrap(synthesizedRotationFrame(fallback: placedWindow, interfaceOrientation: orientation))
      XCTAssertEqual(frame.origin, .zero)
      XCTAssertEqual(frame.width, expected.width, accuracy: 0.5)
      XCTAssertEqual(frame.height, expected.height, accuracy: 0.5)
    }
  }

  /// #4091: when the device's only screen will not report its size, a placed window's smaller box is
  /// no basis to turn about either (#3899), so a tap through a resolved window refuses before it
  /// dispatches instead of landing off target.
  @MainActor
  func testTapRefusesBeforeDispatchWhenTheSoleDisplayCannotBeMeasured() throws {
    try XCTSkipUnless(XCUIScreen.screens.count == 1, "a multi-screen host keeps its panel's window box")
    app.launch()
    mainOwned.app = app
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let window = try XCTUnwrap(resolveRunnerWindowElement(app: app)).window
    let placedWindow = CGRect(x: 224, y: 207, width: 386, height: 682)
    let context = try XCTUnwrap(
      SynthesizedCoordinateContext(validating: placedWindow, resolvedWindow: window, accessibilityHealth: .healthy)
    )
    let restoreAXRuntime = try simulateUnreadableSystemApplication()
    defer { restoreAXRuntime() }

    XCTAssertNil(
      synthesizedRotationFrame(fallback: placedWindow, interfaceOrientation: RunnerInterfaceOrientation.landscapeRight)
    )
    let outcome = synthesizedTapAt(app: app, x: 40, y: 40, context: context)
    guard case .unsupported(let message, _)? = outcome else {
      return XCTFail("expected a refusal before dispatch, got \(String(describing: outcome))")
    }
    guard case .unsupported(let refusal, _) = Self.unmeasuredSoleDisplayOutcome(gesture: "tap") else {
      return XCTFail("the unmeasured-display outcome must be a refusal")
    }
    XCTAssertEqual(message, refusal)
  }
#endif

  func testSoleScreenReferenceFrameRefusesAnUnknownOrientationOrAnEmptyScreen() {
    XCTAssertNil(
      Self.soleScreenReferenceFrame(
        portraitSize: CGSize(width: 402, height: 874),
        interfaceOrientation: RunnerInterfaceOrientation.unknown
      )
    )
    XCTAssertNil(
      Self.soleScreenReferenceFrame(
        portraitSize: .zero,
        interfaceOrientation: RunnerInterfaceOrientation.portrait
      )
    )
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
