import AgentDeviceSnapshotPresentation
import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

private final class LitPanelBookingScreen: NSObject {
  @objc let displayID: UInt

  init(_ displayID: UInt = 3) { self.displayID = displayID }
}

@MainActor
private final class LitPanelBookingProbe: NSObject {
  static var originalValueForKey: IMP?
  static let query = NSObject()
  static var windowListReads = 0
  static var maxWindowListReads: Int?
  static var window: XCUIElement?
  static var darkWindow: XCUIElement?
  static var coordinate: XCUICoordinate?
  static var windowFrame = CGRect.zero
  static var orientation = RunnerInterfaceOrientation.landscapeLeft
  static var anchor: NSObject?
  static var point = CGPoint.zero
  static var tappedPoint: CGPoint?

  @objc class func interfaceOrientation(forApplication application: AnyObject) -> Int { orientation }

  nonisolated override func value(forKey key: String) -> Any? {
    MainActor.assumeIsolated {
      switch key {
      case "windows": return Self.query
      case "allElementsBoundByIndex":
        Self.windowListReads += 1
        if let max = Self.maxWindowListReads, Self.windowListReads > max { return [] }
        return [Self.window!, Self.darkWindow].compactMap { $0 }
      case "screen": return LitPanelBookingScreen(self === Self.darkWindow ? 1 : 3)
      case "exists": return true
      case "frame": return NSValue(cgRect: Self.windowFrame)
      default: break
      }
      let original = unsafeBitCast(
        Self.originalValueForKey!,
        to: (@convention(c) (AnyObject, Selector, NSString) -> AnyObject?).self
      )
      return original(self, #selector(NSObject.value(forKey:)), key as NSString)
    }
  }

  @objc(coordinateWithNormalizedOffset:)
  func coordinateWithNormalizedOffset(_ offset: CGVector) -> XCUICoordinate {
    Self.anchor = self
    Self.point = CGPoint(
      x: Self.windowFrame.minX + offset.dx * Self.windowFrame.width,
      y: Self.windowFrame.minY + offset.dy * Self.windowFrame.height
    )
    return Self.coordinate!
  }

  @objc(coordinateWithOffset:)
  func coordinateWithOffset(_ offset: CGVector) -> XCUICoordinate {
    Self.point.x += offset.dx
    Self.point.y += offset.dy
    return Self.coordinate!
  }

  @objc func tap() { Self.tappedPoint = Self.point }
}

extension RunnerTests {
  @MainActor
  func testLitPanelBookingAndCoordinateFallbackShareScreenPointsForPartialWindows() throws {
    try withLitPanelBookingProbe { window in
      for (frame, orientation, expected) in [
        (
          CGRect(x: 80, y: 0, width: 871, height: 669), RunnerInterfaceOrientation.landscapeLeft,
          CGRect(x: 0, y: 0, width: 951, height: 669)
        ),
        (
          CGRect(x: 0, y: 80, width: 669, height: 871), RunnerInterfaceOrientation.portrait,
          CGRect(x: 0, y: 0, width: 669, height: 951)
        ),
        (
          CGRect(x: 80, y: 0, width: 180, height: 669), RunnerInterfaceOrientation.landscapeRight,
          CGRect(x: 0, y: 0, width: 951, height: 669)
        ),
        (
          CGRect(x: 0, y: 80, width: 669, height: 871), RunnerInterfaceOrientation.portraitUpsideDown,
          CGRect(x: 0, y: 0, width: 669, height: 951)
        ),
      ] {
        LitPanelBookingProbe.windowFrame = frame
        LitPanelBookingProbe.orientation = orientation
        LitPanelBookingProbe.tappedPoint = nil
        setRequestLitPanel(from: try runnerCommandFixture(
          #"{"command":"tap","litPanel":{"displayId":3,"widthPt":669,"heightPt":951}}"#
        ))
        XCTAssertNil(bookRequestLitPanelSurface(app: app))
        let booked = try XCTUnwrap(litPanelState.surface)
        XCTAssertTrue(booked.window === window)
        XCTAssertEqual(booked.frame, frame)
        XCTAssertEqual(synthesizedRotationFrame(app: app, fallback: booked.frame, interfaceOrientation: orientation), expected)
        if case .unsupported(let message, _) = try tapAt(app: app, x: 200, y: 150) { XCTFail(message) }
        XCTAssertTrue(LitPanelBookingProbe.anchor === window)
        XCTAssertEqual(LitPanelBookingProbe.tappedPoint, CGPoint(x: 200, y: 150))
      }
      LitPanelBookingProbe.tappedPoint = nil
      setRequestLitPanel(from: try runnerCommandFixture(
        #"{"command":"tap","litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
      ))
      XCTAssertThrowsError(try tapAt(app: app, x: 200, y: 150)) {
        XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .offLitPanel)
      }
      XCTAssertNil(LitPanelBookingProbe.tappedPoint)

    }
  }

  @MainActor
  func testCollapsedTabCandidatesExcludeOverlappingDarkWindowsAndKeepTheCaptureScope() throws {
    try withLitPanelBookingProbe { window in
      let darkWindow = XCUIApplication(bundleIdentifier: "com.apple.springboard").windows.firstMatch
      LitPanelBookingProbe.darkWindow = darkWindow
      LitPanelBookingProbe.windowFrame = CGRect(x: 0, y: 0, width: 669, height: 951)
      setRequestLitPanel(from: try runnerCommandFixture(
        #"{"command":"snapshot","litPanel":{"displayId":3,"widthPt":669,"heightPt":951}}"#
      ))
      XCTAssertNil(bookRequestLitPanelSurface(app: app))
      let container = ElementAttributesFixture(.tabBar, CGRect(x: 0, y: 800, width: 669, height: 31))
      let context = SnapshotTraversalContext(
        queryRoot: app,
        rootSnapshot: ElementAttributesFixture(.application, LitPanelBookingProbe.windowFrame, children: [
          ElementAttributesFixture(.window, LitPanelBookingProbe.windowFrame, children: [container], displayID: 3),
        ]),
        rootReadDuration: 0,
        viewport: .missing(reason: .notProvided),
        keyboardBand: nil,
        litPanelSurface: try XCTUnwrap(litPanelState.surface)
      )
      let lit = ElementAttributesFixture(.button, CGRect(x: 30, y: 800, width: 100, height: 30), label: "Lit")
      let second = ElementAttributesFixture(.button, CGRect(x: 170, y: 800, width: 100, height: 30), label: "Second")
      let dark = ElementAttributesFixture(.button, lit.frame, label: "Dark")
      let appQuery = app.descendants(matching: .any)
      let litQuery = window.descendants(matching: .any)
      let darkQuery = darkWindow.descendants(matching: .any)
      var predicates: [ObjectIdentifier: NSPredicate] = [:]
      var restores: [() -> Void] = []
      defer { restores.reversed().forEach { $0() } }
      func swap(_ type: AnyClass, _ name: String, _ block: Any) throws {
        let method = try XCTUnwrap(class_getInstanceMethod(type, NSSelectorFromString(name)))
        let replacement = imp_implementationWithBlock(block)
        let original = method_setImplementation(method, replacement)
        restores.append {
          method_setImplementation(method, original)
          imp_removeBlock(replacement)
        }
      }
      try swap(XCUIElement.self, "descendantsMatchingType:", { (root: AnyObject, _: UInt) -> XCUIElementQuery in
        root === window ? litQuery : root === darkWindow ? darkQuery : appQuery
      } as @convention(block) (AnyObject, UInt) -> XCUIElementQuery)
      try swap(XCUIElementQuery.self, "matchingPredicate:", { (query: AnyObject, predicate: NSPredicate) -> XCUIElementQuery in
        predicates[ObjectIdentifier(query)] = predicate
        return query as! XCUIElementQuery
      } as @convention(block) (AnyObject, NSPredicate) -> XCUIElementQuery)
      try swap(XCUIElementQuery.self, "allElementsBoundByIndex", { (query: AnyObject) -> NSArray in
        let attributes = query === litQuery ? [lit, second] : query === darkQuery ? [dark] : [lit, second, dark]
        let matches = attributes.filter { predicates[ObjectIdentifier(query)]?.evaluate(with: $0) == true }
        return matches.isEmpty ? [] : [window]
      } as @convention(block) (AnyObject) -> NSArray)
      let candidates = try XCTUnwrap(try collapsedTabCandidates(context: context, processingDeadline: .distantFuture))
      XCTAssertEqual(candidates.map(\.label), ["Lit", "Second"], "an overlapping control on a dark window must not enter the capture")
      let hint = CaptureHint(projection: .regular, depth: nil, regularPresentedDepth: nil, interactiveOnly: false, customActions: false)
      let capture = try recursiveTreeSnapshotAcquisition(context: context, hint: hint, processingDeadline: .distantFuture)
      let labels = capture.acquisition.nodes.compactMap(\.label)
      XCTAssertTrue(labels.contains("Lit"))
      XCTAssertTrue(labels.contains("Second"))
      XCTAssertFalse(labels.contains("Dark"), "the serialized capture must exclude the overlapping dark control")
      endRequestLitPanel(try XCTUnwrap(litPanelState.requestID))
      let pinned = try XCTUnwrap(try collapsedTabCandidates(context: context, processingDeadline: .distantFuture))
      XCTAssertEqual(pinned.map(\.label), ["Lit", "Second"], "the capture's display scope survives a cleared current request")
      var unscoped = context
      unscoped.litPanelSurface = nil
      let all = try XCTUnwrap(try collapsedTabCandidates(context: unscoped, processingDeadline: .distantFuture))
      XCTAssertEqual(all.map(\.label), ["Lit", "Second", "Dark"], "an unscoped capture keeps application-wide candidates")
      litPanelWindowWalkIssueForTesting = true
      defer { litPanelWindowWalkIssueForTesting = false }
      XCTAssertThrowsError(try collapsedTabCandidates(context: context, processingDeadline: .distantFuture)) {
        XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .unresolvedScreen)
      }
    }
  }

  @MainActor
  func testLitPanelBookingUsesBundleIdentityAcrossProxiesAndRequests() throws {
    try withLitPanelBookingProbe { window in
      let bundleID = try XCTUnwrap(app.value(forKey: "bundleID") as? String)
      let sameApp = XCUIApplication(bundleIdentifier: bundleID)
      let otherApp = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      let secondWindow = otherApp.windows.firstMatch
      let command = try runnerCommandFixture(#"{"command":"tap","litPanel":{"displayId":3,"widthPt":669,"heightPt":951}}"#)
      LitPanelBookingProbe.windowFrame = CGRect(x: 80, y: 0, width: 871, height: 669)
      let firstRequest = setRequestLitPanel(from: command)
      XCTAssertNil(bookRequestLitPanelSurface(app: app))
      let firstReads = LitPanelBookingProbe.windowListReads
      XCTAssertNil(bookRequestLitPanelSurface(app: sameApp))
      XCTAssertEqual(LitPanelBookingProbe.windowListReads, firstReads, "a second proxy of the same bundle reuses this request's booking")
      LitPanelBookingProbe.window = secondWindow
      LitPanelBookingProbe.windowFrame = CGRect(x: 0, y: 80, width: 669, height: 871)
      XCTAssertNil(bookRequestLitPanelSurface(app: otherApp))
      XCTAssertTrue(try requireRequestLitPanelSurface(app: otherApp).window === secondWindow)
      XCTAssertGreaterThan(LitPanelBookingProbe.windowListReads, firstReads)
      LitPanelBookingProbe.window = window
      let nextRequest = setRequestLitPanel(from: command)
      endRequestLitPanel(firstRequest)
      XCTAssertNil(bookRequestLitPanelSurface(app: sameApp))
      XCTAssertTrue(try requireRequestLitPanelSurface(app: app).window === window)
      XCTAssertEqual(litPanelState.surface?.key.requestID, nextRequest)
      endRequestLitPanel(nextRequest)
      XCTAssertNil(litPanelState.surface)
      XCTAssertNil(requestLitPanel)
    }
  }

  @MainActor
  func testAcceptedRequestEndsItsLitPanelBooking() throws {
    try withLitPanelBookingProbe { _ in
      let command = try runnerCommandFixture(#"{"command":"uptime","litPanel":{"displayId":3,"widthPt":669,"heightPt":951}}"#)
      _ = try executeAccepted(command: command)
      XCTAssertNil(requestLitPanel, "finished commands cannot leave a panel for unrelated main work")
      XCTAssertNil(litPanelState.surface)
    }
  }

  @MainActor
  func testDuplicateSelectorRefusesWithoutTryingToBookATapPoint() throws {
    app.launchArguments = ["--agent-device-selector-read-regression"]
    try withLitPanelBookingProbe { _ in
      LitPanelBookingProbe.windowFrame = CGRect(x: 0, y: 0, width: 669, height: 951)
      LitPanelBookingProbe.maxWindowListReads = 1
      setRequestLitPanel(from: try runnerCommandFixture(
        #"{"command":"tap","litPanel":{"displayId":3,"widthPt":669,"heightPt":951}}"#
      ))
      let match = try findElement(app: app, selectorKey: "id", selectorValue: "agent-device-selector-read-duplicate")
      XCTAssertTrue(match.isAmbiguous)
      XCTAssertNil(match.element)
      XCTAssertEqual(LitPanelBookingProbe.windowListReads, 1, "ambiguity does not require a coordinate booking")
    }
  }

  @MainActor
  func testFailedLitPanelBookingRefusesEveryReferenceFrameConsumer() throws {
    try withLitPanelBookingProbe { _ in
      LitPanelBookingProbe.windowFrame = CGRect(x: 0, y: 0, width: 669, height: 951)
      setRequestLitPanel(from: try runnerCommandFixture(
        #"{"command":"tap","litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
      ))
      func refuses<T>(_ read: () throws -> T) {
        XCTAssertThrowsError(try read()) {
          XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .offLitPanel)
        }
      }
      refuses { try resolveRunnerWindow(app: app) }
      refuses { try onScreenWindowFrame(app: app) }
      refuses { try resolvedTouchReferenceFrame(app: app, appFrame: CGRect(x: 0, y: 0, width: 466, height: 678)) }
      refuses { try synthesizedCoordinateContext(app: app) }
      refuses { try gestureViewportFrame(app: app) }
      refuses { try resolvedTouchVisualizationFrame(app: app, x: 20, y: 30) }
      refuses { try resolvedDragVisualizationFrame(app: app, x: 20, y: 30, x2: 40, y2: 50) }
      refuses { try performSynthesizedTapGesture(app: app, x: 20, y: 30) }
      var alertRefusal: Error?
      let held = holdingRecordedIssues {
        do {
          _ = try activateAlertButton(
            RunnerAlert(root: app, ownerApp: app, actions: [app], source: .appAlert, window: nil),
            button: app, action: "accept", frame: CGRect(x: 10, y: 10, width: 40, height: 40), deadline: .distantFuture
          )
        } catch { alertRefusal = error }
      }
      XCTAssertEqual(alertRefusal as? RunnerAppScreenCaptureFailure, .offLitPanel)
      XCTAssertTrue(held.issues.isEmpty, "the typed refusal must survive the idle/interruption wrappers")
    }
  }

  @MainActor
  private func withLitPanelBookingProbe(_ body: (XCUIElement) throws -> Void) throws {
    app.launch()
    defer { app.terminate() }
    let query = app.windows
    let window = query.firstMatch
    LitPanelBookingProbe.window = window
    LitPanelBookingProbe.coordinate = window.coordinate(withNormalizedOffset: .zero)
    let windowClass = try XCTUnwrap(object_getClass(window))
    let coordinateClass = try XCTUnwrap(object_getClass(LitPanelBookingProbe.coordinate!))
    let valueForKey = try XCTUnwrap(class_getInstanceMethod(windowClass, #selector(NSObject.value(forKey:))))
    LitPanelBookingProbe.originalValueForKey = method_getImplementation(valueForKey)
    let swaps: [(Method?, Method?)] = [
      (valueForKey,
       class_getInstanceMethod(LitPanelBookingProbe.self, #selector(NSObject.value(forKey:)))),
      (class_getClassMethod(RunnerSynthesizedGesture.self, #selector(RunnerSynthesizedGesture.interfaceOrientation(forApplication:))),
       class_getClassMethod(LitPanelBookingProbe.self, #selector(LitPanelBookingProbe.interfaceOrientation(forApplication:)))),
      (class_getInstanceMethod(windowClass, #selector(XCUIElement.coordinate(withNormalizedOffset:))),
       class_getInstanceMethod(LitPanelBookingProbe.self, #selector(LitPanelBookingProbe.coordinateWithNormalizedOffset(_:)))),
      (class_getInstanceMethod(coordinateClass, #selector(XCUICoordinate.withOffset(_:))),
       class_getInstanceMethod(LitPanelBookingProbe.self, #selector(LitPanelBookingProbe.coordinateWithOffset(_:)))),
      (class_getInstanceMethod(coordinateClass, #selector(XCUICoordinate.tap)),
       class_getInstanceMethod(LitPanelBookingProbe.self, #selector(LitPanelBookingProbe.tap))),
    ]
    var originals: [(Method, IMP)] = []
    defer {
      for (method, original) in originals.reversed() { method_setImplementation(method, original) }
      LitPanelBookingProbe.darkWindow = nil
      LitPanelBookingProbe.window = nil
      LitPanelBookingProbe.coordinate = nil
      LitPanelBookingProbe.anchor = nil
      LitPanelBookingProbe.originalValueForKey = nil
      LitPanelBookingProbe.maxWindowListReads = nil
      litPanelState.panel = nil
      litPanelState.surface = nil
    }
    for (method, stub) in swaps {
      let method = try XCTUnwrap(method)
      let stub = try XCTUnwrap(stub)
      originals.append((method, method_setImplementation(method, method_getImplementation(stub))))
    }
    LitPanelBookingProbe.windowListReads = 0
    try body(window)
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  /// One runner process can serve a foldable's `tap` and then a single-panel request; the second
  /// must not resolve against the first's panel.
  func testRequestPanelFollowsTheCommandAndAnUnnamedPanelClearsIt() throws {
    setRequestLitPanel(from: try command(namingLitPanel: #"{"displayId":3,"widthPt":669,"heightPt":951}"#))
    XCTAssertEqual(requestLitPanel?.displayID, 3)
    XCTAssertEqual(requestLitPanel?.widthPt, 669)
    XCTAssertEqual(requestLitPanel?.heightPt, 951)

    setRequestLitPanel(from: try command(namingLitPanel: nil))
    XCTAssertNil(requestLitPanel)
  }

  func testRequestPanelTreatsAPanelNamingNoUsableBoxAsNoPanel() throws {
    for panel in [
      #"{"displayId":0,"widthPt":669,"heightPt":951}"#,
      #"{"displayId":3,"widthPt":0,"heightPt":951}"#,
      #"{"displayId":3,"widthPt":669,"heightPt":-951}"#,
    ] {
      setRequestLitPanel(from: try command(namingLitPanel: panel))
      XCTAssertNil(requestLitPanel, panel)
    }
  }

  /// Main work a command abandoned runs before the next command's panel is written, so it still
  /// reads its own command's panel.
  func testRequestLitPanelIsWrittenBehindMainWorkAlreadyQueued() throws {
    let unnamed = try command(namingLitPanel: nil)
    let named = try command(namingLitPanel: #"{"displayId":3,"widthPt":669,"heightPt":951}"#)
    setRequestLitPanel(from: unnamed)
    let drained = expectation(description: "main queue drained")
    var queuedEarlier: UInt?
    var queuedLater: UInt?
    DispatchQueue.global().async {
      DispatchQueue.main.async { queuedEarlier = self.requestLitPanel?.displayID ?? 0 }
      self.setRequestLitPanel(from: named)
      DispatchQueue.main.async {
        queuedLater = self.requestLitPanel?.displayID ?? 0
        drained.fulfill()
      }
    }
    wait(for: [drained], timeout: 5)
    setRequestLitPanel(from: unnamed)
    XCTAssertEqual(queuedEarlier, 0)
    XCTAssertEqual(queuedLater, 3)
  }

  func testLitPanelSnapshotRefusesAPinToABackendThatCannotProveThePanel() throws {
    func refusal(_ fields: String) throws -> ErrorPayload? {
      try Self.litPanelBackendPinRefusal(runnerCommandFixture(#"{"command":"snapshot"\#(fields)}"#))?.error
    }
    XCTAssertEqual(try refusal(#","preferredBackend":"private-ax""#)?.code, "UNSUPPORTED_OPERATION")
    XCTAssertEqual(try refusal(#","preferredBackend":"queries""#)?.code, "UNSUPPORTED_OPERATION")
    XCTAssertNil(try refusal(#","preferredBackend":"tree""#))
    XCTAssertNil(try refusal(""))
    let implied = try XCTUnwrap(refusal(#","customActions":true"#))
    XCTAssertEqual(implied.code, "UNSUPPORTED_OPERATION")
    XCTAssertTrue(implied.message.contains("customActions"), implied.message)
    XCTAssertFalse(implied.hint?.contains("backend pin") ?? true, implied.hint ?? "")
  }

  /// Decoded from JSON, so a renamed wire field fails here.
  private func command(namingLitPanel panel: String?) throws -> Command {
    let fields = ["\"command\":\"tap\"", panel.map { "\"litPanel\":\($0)" }].compactMap { $0 }
    return try JSONDecoder().decode(
      Command.self,
      from: Data("{\(fields.joined(separator: ","))}".utf8)
    )
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  /// A window whose display the runtime does not name may be on the dark panel, so it is dropped.
  func testLitPanelSnapshotKeepsOnlyWindowsProvenOnTheLitDisplay() {
    let windows: [(name: String, displayID: UInt?)] = [("outer", 1), ("unknown", nil), ("inner", 3)]
    let kept = Self.windowsOnLitDisplay(windows, litDisplayID: 3) { $0.displayID }
    XCTAssertEqual(kept.map(\.name), ["inner"])
  }

#if os(iOS)
  /// A window that leaves part of the lit panel uncovered, like an app beside the Duo's 80 pt status
  /// strip, books its own frame as the reference, and a synthesized turn is about the whole panel.
  @MainActor
  func testLitPanelBookingTurnsAboutTheWholePanelForAPartialWindow() throws {
    let (_, frame) = launchAppOnTheLitPanel()
    defer { tearDownLitPanelApp() }
    let window = app.windows.firstMatch
    var displayID: UInt = 0
    XCTAssertNil(RunnerResolveWindowDisplayID(window, &displayID))
    setRequestLitPanel(from: try runnerCommandFixture(
      #"{"command":"tap","litPanel":{"displayId":\#(displayID),"widthPt":\#(frame.width),"heightPt":\#(frame.height + 80)}}"#
    ))
    XCTAssertNil(bookRequestLitPanelSurface(app: app))
    let context = try XCTUnwrap(try synthesizedCoordinateContext(app: app))
    XCTAssertEqual(context.referenceFrame, frame, "the booked reference is the window's own frame")
    XCTAssertEqual(
      synthesizedRotationFrame(app: app, fallback: context.referenceFrame, interfaceOrientation: RunnerInterfaceOrientation.portrait),
      CGRect(x: 0, y: 0, width: frame.width, height: frame.height + 80),
      "the turn is about the whole lit panel, not the window"
    )
  }
  /// Launches the app and names its own window's display and box as the lit panel: the
  /// `litPanel` JSON member, and the window frame.
  @MainActor
  private func launchAppOnTheLitPanel() -> (panel: String, frame: CGRect) {
    app.launch()
    mainOwned.app = app
    let window = app.windows.firstMatch
    var displayID: UInt = 0
    XCTAssertNil(RunnerResolveWindowDisplayID(window, &displayID))
    let frame = window.frame
    return (#""litPanel":{"displayId":\#(displayID),"widthPt":\#(frame.width),"heightPt":\#(frame.height)}"#, frame)
  }

  @MainActor
  private func tearDownLitPanelApp() {
    litPanelWindowWalkIssueForTesting = false
    setRequestLitPanel(from: try! runnerCommandFixture(#"{"command":"tap"}"#))
    invalidateCachedTarget(reason: "unit_test_cleanup")
    app.terminate()
  }

  /// Runs `command` against the launched app while the request names display 999, which none of
  /// the app's windows is on.
  @MainActor
  private func responseWithTheAppOffTheLitPanel(
    _ json: String,
    _ run: (Command) throws -> Response
  ) throws -> Response {
    app.launch()
    mainOwned.app = app
    defer { tearDownLitPanelApp() }
    let command = try runnerCommandFixture(json)
    setRequestLitPanel(from: command)
    return try run(command)
  }

  @MainActor
  func testCoordinateTapRefusesBeforeDispatchWhenTheAppIsOffTheLitPanel() throws {
    var fellBack = true
    let response = try responseWithTheAppOffTheLitPanel(
      #"{"command":"tap","x":40,"y":120,"synthesized":true,"litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
    ) { command in
      let response = try executeOnMainPrepared(command: command, activeApp: app)
      fellBack = resolveRunnerWindowElement(app: app) != nil
      return response
    }
    XCTAssertEqual(response.error?.code, "APP_SCREEN_OFF_LIT_PANEL")
    XCTAssertFalse(fellBack, "no read in the request may fall back to the app")
  }

  /// The app's window is booked on the lit panel, and then a window vanishes during the element
  /// search's walk: the issue is held, the read refuses with the typed code instead of finding
  /// nothing, and a coordinate `type` refuses before it taps a point with no target.
  @MainActor
  func testElementReadsRefuseWhenTheLitPanelWindowWalkFails() throws {
    let (panel, frame) = launchAppOnTheLitPanel()
    defer { tearDownLitPanelApp() }
    for json in [
      #"{"command":"readText","x":\#(frame.midX),"y":\#(frame.midY),\#(panel)}"#,
      #"{"command":"type","text":"x","x":\#(frame.midX),"y":\#(frame.midY),\#(panel)}"#,
    ] {
      let command = try runnerCommandFixture(json)
      setRequestLitPanel(from: command)
      XCTAssertNil(bookRequestLitPanelSurface(app: app), "the window is on the lit panel")
      litPanelWindowWalkIssueForTesting = true
      let response = try executeOnMainPrepared(command: command, activeApp: app)
      litPanelWindowWalkIssueForTesting = false
      XCTAssertEqual(response.error?.code, "APP_SCREEN_UNRESOLVED", json)
    }
  }

  /// A target bound to the regression fixture's field by identifier, refreshed at its center.
  @MainActor
  private func boundFixtureTarget() throws -> TextEntryTarget {
    let identifier = "agent-device-hardware-keyboard-input"
    let field = app.textFields[identifier]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    let frame = field.frame
    return TextEntryTarget(
      element: nil,
      refreshPoint: CGPoint(x: frame.midX, y: frame.midY),
      prefersFocusedElement: false,
      contentTranslation: .none,
      boundIdentity: TextEntryInputIdentity(elementType: .textField, identifier: identifier)
    )
  }

  /// A bound input re-read on a lit-panel request whose walk fails propagates the refusal, and the
  /// input cannot be proven gone.
  @MainActor
  func testBoundInputReReadRefusesWhenTheLitPanelWalkFails() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    let (panel, _) = launchAppOnTheLitPanel()
    defer {
      app.launchArguments = []
      tearDownLitPanelApp()
    }
    let target = try boundFixtureTarget()
    let command = try runnerCommandFixture(#"{"command":"type",\#(panel)}"#)
    setRequestLitPanel(from: command)
    XCTAssertNotNil(try resolveTextEntryInput(app: app, target: target), "the walk answers")
    litPanelWindowWalkIssueForTesting = true
    XCTAssertThrowsError(try resolveTextEntryInput(app: app, target: target)) {
      XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .unresolvedScreen)
    }
    XCTAssertThrowsError(try clearedFieldRead(app: app, target: target), "a clear pass read propagates it too") {
      XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .unresolvedScreen)
    }
    XCTAssertThrowsError(try boundTextEntryInputIsGone(app: app, target: target)) {
      XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .unresolvedScreen)
    }
  }

  /// A bound input read refuses when every window is off the named panel, even if the app-wide
  /// query can resolve the same input.
  @MainActor
  func testBoundInputIdentifierReadRefusesWhenAllWindowsAreOffTheLitPanel() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    mainOwned.app = app
    defer {
      app.launchArguments = []
      tearDownLitPanelApp()
    }
    let target = try boundFixtureTarget()
    setRequestLitPanel(from: try runnerCommandFixture(#"{"command":"type"}"#))
    XCTAssertNotNil(try resolveTextEntryInput(app: app, target: target), "the app-wide query finds it")
    setRequestLitPanel(from: try runnerCommandFixture(
      #"{"command":"type","litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
    ))
    let point = try XCTUnwrap(target.refreshPoint)
    XCTAssertThrowsError(try probeTextInputs(app: app, point: point, contentTranslation: .none)) {
      XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .unresolvedScreen)
    }
    XCTAssertThrowsError(try resolveTextEntryInput(app: app, target: target)) {
      XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .unresolvedScreen)
    }
  }

  /// With a lit panel named, selector and point reads search only the windows on that display; the
  /// launched app's windows are all on another one, so neither read may answer.
  @MainActor
  func testElementReadsSearchOnlyTheLitDisplaysWindows() throws {
    _ = try responseWithTheAppOffTheLitPanel(
      #"{"command":"tap","x":1,"y":1,"litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
    ) { _ in
      XCTAssertThrowsError(try findElement(app: app, selectorKey: "label", selectorValue: "Agent Device Runner")) {
        XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .unresolvedScreen)
      }
      setRequestLitPanel(from: try runnerCommandFixture(#"{"command":"tap"}"#))
      let match = try findElement(app: app, selectorKey: "label", selectorValue: "Agent Device Runner")
      let element = try XCTUnwrap(match.element)
      let frame = element.frame
      XCTAssertNotNil(try readTextAt(app: app, x: frame.midX, y: frame.midY))
      setRequestLitPanel(from: try runnerCommandFixture(
        #"{"command":"tap","litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
      ))
      XCTAssertThrowsError(try readTextAt(app: app, x: frame.midX, y: frame.midY)) {
        XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .unresolvedScreen)
      }
      return Response(ok: true)
    }
  }

  @MainActor
  func testCollapsedTabSnapshotReadsProvenLitLiveWindows() throws {
    app.launchArguments = ["--agent-device-collapsed-tab-bar", "--agent-device-wide-slider"]
    let (panel, _) = launchAppOnTheLitPanel()
    defer { tearDownLitPanelApp() }
    setRequestLitPanel(from: try runnerCommandFixture(#"{"command":"snapshot",\#(panel)}"#))
    XCTAssertNil(bookRequestLitPanelSurface(app: app))
    let hint = CaptureHint(projection: .regular, depth: nil, regularPresentedDepth: nil, interactiveOnly: false, customActions: false)
    let context = try XCTUnwrap(try makeSnapshotTraversalContext(
      app: app,
      hint: hint,
      litPanelSurface: try XCTUnwrap(litPanelState.surface)
    ))
    let container = try XCTUnwrap(Self.snapshotDescendants(of: context.rootSnapshot).first { $0.elementType == .tabBar })
    XCTAssertTrue(container.children.isEmpty, "the live fixture must reach collapsed-tab recovery")
    let candidates = try XCTUnwrap(try collapsedTabCandidates(context: context, processingDeadline: .distantFuture))
    XCTAssertTrue(candidates.contains { $0.label == "Left" })
    XCTAssertTrue(candidates.contains { $0.label == "Right" })
    let capture = try recursiveTreeSnapshotAcquisition(context: context, hint: hint, processingDeadline: .distantFuture)
    let labels = capture.acquisition.nodes.compactMap(\.label)
    XCTAssertTrue(labels.contains("Left"))
    XCTAssertTrue(labels.contains("Right"))
  }

  /// A refused pin is a request refusal: it never reaches the capture plan, so it does not
  /// invalidate the cached target the next command relies on.
  @MainActor
  func testLitPanelSnapshotPinRefusalKeepsTheCachedTarget() throws {
    let (panel, _) = launchAppOnTheLitPanel()
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    defer { tearDownLitPanelApp() }
    let command = try runnerCommandFixture(
      #"{"appBundleId":"com.callstack.agentdevice.runner","command":"snapshot","preferredBackend":"private-ax",\#(panel)}"#
    )
    setRequestLitPanel(from: command)
    let response = try executeSnapshotDispatched(command: command)
    XCTAssertEqual(response.error?.code, "UNSUPPORTED_OPERATION")
    XCTAssertTrue(mainOwned.app === app, "a refused pin must not invalidate the cached target")
  }

  @MainActor
  func testSnapshotRefusesWhenTheAppIsOffTheLitPanel() throws {
    let response = try responseWithTheAppOffTheLitPanel(
      #"{"command":"snapshot","interactiveOnly":true,"litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
    ) { try executeSnapshotDispatched(command: $0) }
    XCTAssertEqual(response.error?.code, "APP_SCREEN_OFF_LIT_PANEL")
  }
#endif
}
#endif
