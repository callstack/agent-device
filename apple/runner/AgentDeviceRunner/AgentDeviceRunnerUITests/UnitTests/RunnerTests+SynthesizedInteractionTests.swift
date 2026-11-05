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

/// Physical iOS can expose no usable accessibility frame for the system application.
private final class RunnerUnreadableSystemApplicationStub: NSObject {
  @objc class func systemApplication() -> AnyObject? { nil }
}

extension RunnerTests {
  /// Installs `RunnerUnreadableSystemApplicationStub` on AXRuntime's `AXElement` until the returned
  /// closure restores it.
  private func simulateUnreadableSystemApplication() throws -> () -> Void {
    _ = dlopen("/System/Library/PrivateFrameworks/AXRuntime.framework/AXRuntime", RTLD_NOW)
    let element: AnyClass = try XCTUnwrap(NSClassFromString("AXElement"))
    let selector = NSSelectorFromString("systemApplication")
    let target = try XCTUnwrap(class_getClassMethod(element, selector))
    let stub = try XCTUnwrap(class_getClassMethod(RunnerUnreadableSystemApplicationStub.self, selector))
    let original = method_setImplementation(target, method_getImplementation(stub))
    return { method_setImplementation(target, original) }
  }

  private func simulateUnreadableDisplay() throws -> () -> Void {
    try overrideSoleScreenValues(["scale": NSNumber(value: 0)])
  }

  func overrideSoleScreenValues(
    _ values: [String: AnyObject], didRead: @escaping (String) -> Void = { _ in }
  ) throws -> () -> Void {
    let selector = #selector(NSObject.value(forKey:))
    let inherited = try XCTUnwrap(class_getInstanceMethod(XCUIScreen.self, selector))
    class_addMethod(XCUIScreen.self, selector, method_getImplementation(inherited), method_getTypeEncoding(inherited))
    let target = try XCTUnwrap(class_getInstanceMethod(XCUIScreen.self, selector))
    let original = method_getImplementation(target)
    typealias ReadValue = @convention(c) (AnyObject, Selector, NSString) -> AnyObject?
    let readValue = unsafeBitCast(original, to: ReadValue.self)
    let read: @convention(block) (AnyObject, NSString) -> AnyObject? = { screen, key in
      didRead(key as String)
      if let value = values[key as String] { return value }
      return readValue(screen, selector, key)
    }
    let replacement = imp_implementationWithBlock(read)
    method_setImplementation(target, replacement)
    return {
      method_setImplementation(target, original)
      imp_removeBlock(replacement)
    }
  }

  /// Sets the requested orientation and waits for the host app's interface to follow.
  @MainActor
  private func rotateHostApp(landscape: Bool) throws -> () -> Void {
    XCUIDevice.shared.orientation = landscape ? .landscapeLeft : .portrait
    let restore = { XCUIDevice.shared.orientation = .portrait }
    let expected = landscape
      ? [RunnerInterfaceOrientation.landscapeLeft, RunnerInterfaceOrientation.landscapeRight]
      : [RunnerInterfaceOrientation.portrait]
    let deadline = Date().addingTimeInterval(5)
    while !expected.contains(Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))),
      Date() < deadline
    {
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    let turned = expected.contains(Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app)))
    if !turned { restore() }
    _ = try XCTUnwrap(turned ? true : nil, "the host app did not follow the requested orientation")
    return restore
  }

  /// The state the unreadable-display tap tests start from: the host app launched (turned to landscape when
  /// asked), a tap context on its resolved window (measured at `windowFrame` when given) or, when
  /// the window query is rejected, an unserializable tree and no context, and XCTest's display
  /// read failing with no kept size. The returned cleanup undoes every step.
  @MainActor
  private func launchWithUnreadableDisplay(
    landscape: Bool,
    windowFrame: CGRect? = nil,
    windowQueryRejected: Bool = false
  ) throws -> (context: SynthesizedCoordinateContext?, cleanup: () -> Void) {
    var cleanups: [() -> Void] = []
    let cleanup = { for step in cleanups.reversed() { step() } }
    do {
      app.launch()
      mainOwned.app = app
      cleanups.append {
        self.invalidateCachedTarget(reason: "unit_test_cleanup")
        self.app.terminate()
      }
      cleanups.append(try rotateHostApp(landscape: landscape))
      var context: SynthesizedCoordinateContext?
      if !windowQueryRejected {
        let resolved = try XCTUnwrap(resolveRunnerWindowElement(app: app))
        context = try XCTUnwrap(
          SynthesizedCoordinateContext(
            validating: surfaceGeometry(windowFrame: windowFrame ?? resolved.frame, app: app),
            resolvedWindow: resolved.window,
            accessibilityHealth: .healthy
          )
        )
      }
      cleanups.append(try simulateUnreadableDisplay())
      if windowQueryRejected { cleanups.append(try simulateUnserializableAppTree()) }
      // An earlier gesture may have kept a successful read; this one must reach XCTest.
      mainOwned.soleDisplayPortraitSize = nil
      return (context, cleanup)
    } catch {
      cleanup()
      throw error
    }
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

  @MainActor
  private func unscopedDigitizerBasis(
    app: XCUIApplication, window: CGRect, interfaceOrientation: Int
  ) -> CGRect? {
    digitizerGeometry(app: app, surface: SurfaceGeometry(
      windowOnScreen: SurfaceRect(window), panelNativeSize: nil, orientation: interfaceOrientation
    ))?.digitizerBasis.rect
  }

  /// Physical iOS can report no system application's AX frame while its display is measurable.
  @MainActor
  func testSoleDisplaySizeDoesNotRequireASystemApplicationAccessibilityFrame() throws {
    try XCTSkipUnless(XCUIScreen.screens.count == 1, "the rotation basis requires one display")
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    try XCTSkipUnless(soleScreenRouteIsOpen(for: app), "the host app must fill the display")
    let frame = app.frame
    let restoreUIKit = try simulateCompatibilityModeScreen()
    defer { restoreUIKit() }
    let restoreAXRuntime = try simulateUnreadableSystemApplication()
    defer { restoreAXRuntime() }
    mainOwned.soleDisplayPortraitSize = nil
    let placedWindow = CGRect(x: 224, y: 207, width: 386, height: 682)
    let measured = try XCTUnwrap(unscopedDigitizerBasis(
      app: app, window: placedWindow, interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
    ))
    XCTAssertEqual(measured.origin, .zero)
    XCTAssertEqual(measured.width, max(frame.width, frame.height), accuracy: 0.5)
    XCTAssertEqual(measured.height, min(frame.width, frame.height), accuracy: 0.5)
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
    // Portrait and an unknown orientation skip the read; landscape and upside-down read the box.
    let expectations = [
      (RunnerInterfaceOrientation.portraitUpsideDown, screen),
      (RunnerInterfaceOrientation.landscapeRight, CGSize(width: screen.height, height: screen.width)),
    ]
    for (orientation, expected) in expectations {
      let frame = try XCTUnwrap(unscopedDigitizerBasis(app: app, window: placedWindow, interfaceOrientation: orientation))
      XCTAssertEqual(frame.origin, .zero)
      XCTAssertEqual(frame.width, expected.width, accuracy: 0.5)
      XCTAssertEqual(frame.height, expected.height, accuracy: 0.5)
    }
  }

  /// A command keeps its first successful display size and later gestures take it even while the
  /// display read would fail. The next command reads again, because
  /// display scaling can change the size, and a failed read is not kept.
  @MainActor
  func testSoleDisplaySizeIsReadOncePerCommandAndAFailedReadIsNotKept() throws {
    try XCTSkipUnless(XCUIScreen.screens.count == 1, "a multi-screen host keeps its panel's window box")
    let placedWindow = CGRect(x: 224, y: 207, width: 386, height: 682)
    let landscape = RunnerInterfaceOrientation.landscapeRight
    mainOwned.soleDisplayPortraitSize = nil
    let measured = try XCTUnwrap(unscopedDigitizerBasis(app: app, window: placedWindow, interfaceOrientation: landscape))
    XCTAssertNotEqual(measured, placedWindow)

    let nextCommand = try runnerCommandFixture(#"{"command":"uptime","commandId":"next-command"}"#)
    // Nothing between the install and the restore throws, so the restore always runs.
    let restoreDisplay = try simulateUnreadableDisplay()
    XCTAssertEqual(unscopedDigitizerBasis(app: app, window: placedWindow, interfaceOrientation: landscape), measured)
    _ = try? executeOnMainPrepared(command: nextCommand, activeApp: app)
    XCTAssertNotEqual(
      unscopedDigitizerBasis(app: app, window: placedWindow, interfaceOrientation: landscape),
      measured,
      "the next command must read the size again rather than reuse the kept one"
    )
    restoreDisplay()
    XCTAssertEqual(unscopedDigitizerBasis(app: app, window: placedWindow, interfaceOrientation: landscape), measured)
  }

  /// #4091: a portrait turn leaves the point as it is, so an unreadable display box neither refuses
  /// it nor is read for it: the tap is dispatched even through a placed window on either family.
  @MainActor
  func testPortraitTapDispatchesWhenTheSoleDisplayCannotBeMeasured() throws {
    try XCTSkipUnless(XCUIScreen.screens.count == 1, "a multi-screen host keeps its panel's window box")
    let placedWindow = CGRect(x: 224, y: 207, width: 386, height: 682)
    let (context, cleanup) = try launchWithUnreadableDisplay(landscape: false, windowFrame: placedWindow)
    defer { cleanup() }
    XCTAssertEqual(
      Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app)),
      RunnerInterfaceOrientation.portrait
    )

    let outcome = try synthesizedTapAt(app: app, x: 40, y: 40, context: context)
    guard case .performed? = outcome else {
      return XCTFail("expected a portrait tap to be dispatched, got \(String(describing: outcome))")
    }
  }

  /// #4091: with the window query rejected (a tree XCTest cannot serialize) and the display
  /// unreadable there is no box at all. A portrait turn leaves the point as it is, so an admitted sole
  /// screen still takes the tap as given.
  @MainActor
  func testWindowlessPortraitTapDispatchesWhenTheSoleDisplayCannotBeMeasured() throws {
    try XCTSkipUnless(XCUIScreen.screens.count == 1, "a multi-screen host keeps its panel's window box")
    let (_, cleanup) = try launchWithUnreadableDisplay(landscape: false, windowQueryRejected: true)
    defer { cleanup() }
    try XCTSkipUnless(
      soleScreenRouteIsOpen(for: app),
      "the sole-screen rule must admit the app; the landscape test covers refusal"
    )
    XCTAssertEqual(
      Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app)),
      RunnerInterfaceOrientation.portrait
    )

    let outcome = try synthesizedTapAt(app: app, x: 40, y: 40)
    guard case .performed? = outcome else {
      return XCTFail("expected a window-less portrait tap to be dispatched, got \(String(describing: outcome))")
    }
  }

  /// #4091: a landscape turn needs the box, and with the window query rejected no window can stand in
  /// for an unreadable display, so the tap refuses before it dispatches instead of falling back to the
  /// runner's own `UIScreen`.
  @MainActor
  func testWindowlessLandscapeTapRefusesWhenTheSoleDisplayCannotBeMeasured() throws {
    try XCTSkipUnless(XCUIScreen.screens.count == 1, "a multi-screen host keeps its panel's window box")
    let (_, cleanup) = try launchWithUnreadableDisplay(landscape: true, windowQueryRejected: true)
    defer { cleanup() }

    let outcome = try synthesizedTapAt(app: app, x: 40, y: 40)
    guard case .unsupported(let message, _)? = outcome else {
      return XCTFail("expected a refusal before dispatch, got \(String(describing: outcome))")
    }
    XCTAssertEqual(message, "synthesized coordinate tap could not resolve an app window with a finite screen frame")
  }

  /// #4091: when the device's only screen will not report its size, an app the sole-screen rule
  /// proves full-screen (an iPhone by its idiom) has a window that is the display, so its tap still
  /// turns about that window and is dispatched.
  @MainActor
  func testTapTurnsAboutTheWindowWhenTheSoleDisplayCannotBeMeasuredOnAFullScreenApp() throws {
    try XCTSkipUnless(XCUIScreen.screens.count == 1, "a multi-screen host keeps its panel's window box")
    let (context, cleanup) = try launchWithUnreadableDisplay(landscape: true)
    defer { cleanup() }
    try XCTSkipUnless(
      soleScreenRouteIsOpen(for: app),
      "the app must provably fill the screen; the refusal test covers it"
    )

    let orientation = Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))
    let windowFrame = try XCTUnwrap(context).geometry.windowOnScreen.rect
    XCTAssertEqual(
      unscopedDigitizerBasis(app: app, window: windowFrame, interfaceOrientation: orientation),
      windowFrame
    )
    let outcome = try synthesizedTapAt(app: app, x: 40, y: 40, context: context)
    guard case .performed? = outcome else {
      return XCTFail("expected the tap to be dispatched about the window, got \(String(describing: outcome))")
    }
  }

  /// #4091: when the device's only screen will not report its size and the app is not proven to fill
  /// it, a placed window's smaller box is no basis to turn about (#3899), so a tap through a resolved
  /// window refuses before it dispatches instead of landing off target.
  @MainActor
  func testTapRefusesBeforeDispatchWhenTheSoleDisplayCannotBeMeasured() throws {
    try XCTSkipUnless(XCUIScreen.screens.count == 1, "a multi-screen host keeps its panel's window box")
    let placedWindow = CGRect(x: 224, y: 207, width: 386, height: 682)
    let (context, cleanup) = try launchWithUnreadableDisplay(landscape: true, windowFrame: placedWindow)
    defer { cleanup() }
    try XCTSkipIf(
      soleScreenRouteIsOpen(for: app),
      "an app proven full-screen turns about its window; the full-screen test covers it"
    )

    XCTAssertNil(
      unscopedDigitizerBasis(app: app, window: placedWindow, interfaceOrientation: RunnerInterfaceOrientation.landscapeRight)
    )
    XCTAssertEqual(
      unscopedDigitizerBasis(app: app, window: placedWindow, interfaceOrientation: RunnerInterfaceOrientation.portrait),
      placedWindow,
      "portrait skips the box read (only landscape and upside-down read it), so it must not refuse"
    )
    let outcome = try synthesizedTapAt(app: app, x: 40, y: 40, context: context)
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
    XCTAssertEqual(plannedGestureExecution(for: plan), .sampled(schedule: nil))
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
      XCTAssertEqual(plannedGestureExecution(for: plan), .sampled(schedule: nil))
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

    XCTAssertEqual(plannedGestureExecution(for: plan), .sampled(schedule: "timed-pan"))
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

  func testScreenEdgeFlingUsesTheEdgeTouchOnlyOnASimulator() throws {
    let edge = try decodedFlingPlan(contactOrigin: #""screen-edge""#)
    let inPage = try decodedFlingPlan(contactOrigin: nil)

    XCTAssertNil(plannedGestureValidationError(edge))
#if os(iOS) && targetEnvironment(simulator)
    XCTAssertEqual(plannedGestureExecution(for: edge), .screenEdgeTouch)
    XCTAssertEqual(plannedGestureExecution(for: edge).schedule, "edge-ease-in")
#else
    XCTAssertEqual(plannedGestureExecution(for: edge), .fastSwipe)
#endif
    XCTAssertEqual(plannedGestureExecution(for: inPage), .fastSwipe)
    XCTAssertEqual(plannedGestureExecution(for: inPage).schedule, "endpoint-hold")
  }

  func testOnlyASuccessfulPlannedGestureReportsItsSchedule() {
    let performed = Response(ok: true, data: DataPayload(message: "fling"))
    let refused = Response(ok: false, error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: "refused"))

    XCTAssertEqual(Self.reportingSchedule("edge-ease-in", in: performed).data?.executionProfile, "edge-ease-in")
    XCTAssertNil(Self.reportingSchedule(nil, in: performed).data?.executionProfile)
    XCTAssertNil(Self.reportingSchedule("edge-ease-in", in: refused).data)
  }

  func testPlannedGestureRejectsAnUnknownContactOrigin() throws {
    let plan = try decodedFlingPlan(contactOrigin: #""screen-corner""#)

    XCTAssertEqual(plannedGestureValidationError(plan), "planned gesture has an unsupported contact origin")
  }

  func testMultiTouchGestureCannotStartAsAScreenEdgeTouch() throws {
    let plan = try JSONDecoder().decode(
      RunnerGesturePlan.self,
      from: Data(
        #"{"topology":"multi","intent":"pan","contactOrigin":"screen-edge","durationMs":32,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":80,"y":80}},{"offsetMs":32,"point":{"x":100,"y":90}}]},{"pointerId":1,"samples":[{"offsetMs":0,"point":{"x":80,"y":120}},{"offsetMs":32,"point":{"x":100,"y":130}}]}]}"#.utf8
      )
    )

    XCTAssertEqual(
      plannedGestureValidationError(plan),
      "only a single-pointer gesture can start as a screen-edge touch"
    )
  }

  /// A right-edge fling; `contactOrigin` is the raw JSON value, or nil to omit the field.
  private func decodedFlingPlan(contactOrigin: String?) throws -> RunnerGesturePlan {
    let origin = contactOrigin.map { #""contactOrigin":\#($0),"# } ?? ""
    let json = #"{"topology":"single","intent":"fling","executionProfile":"endpoint-hold",\#(origin)"durationMs":100,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":8,"y":150}},{"offsetMs":100,"point":{"x":170,"y":150}}]}]}"#
    return try JSONDecoder().decode(RunnerGesturePlan.self, from: Data(json.utf8))
  }

}
#endif
