import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private final class DisplayScreenFixture: NSObject {
  @objc let displayID: UInt
  init(_ displayID: UInt) { self.displayID = displayID }
}

/// A window the runtime answers only once its query has resolved. `frame` is the read that
/// resolves it: while the query is unresolved `screen` names main, which is what a fresh runner
/// process that has not queried this app yet reports (#2728).
private final class DisplayWindowFixture: NSObject {
  private let windowFrame: CGRect
  private let resolvedDisplayID: UInt
  private let present: Bool
  private(set) var resolved = false
  private lazy var windowScreen = DisplayScreenFixture(resolvedDisplayID)
  init(frame: CGRect, displayID: UInt, present: Bool = true) {
    self.windowFrame = frame
    self.resolvedDisplayID = displayID
    self.present = present
  }
  @objc var exists: Bool { present }
  @objc var frame: CGRect {
    resolved = true
    return windowFrame
  }
  // Handed back as one object so a test can prove the resolver captures the screen the window
  // reported rather than a fresh value for the same key. Unresolved, it names main.
  @objc var screen: NSObject { resolved ? windowScreen : DisplayScreenFixture(1) }
}

private final class DisplayWindowsFixture: NSObject {
  @objc let firstMatch: NSObject
  @objc let allElementsBoundByIndex: [NSObject]
  init(_ window: NSObject) {
    firstMatch = window
    allElementsBoundByIndex = [window]
  }
  init(windows: [NSObject]) {
    firstMatch = windows.first ?? NSObject()
    allElementsBoundByIndex = windows
  }
}

private final class DisplayApplicationFixture: NSObject {
  @objc let windows: NSObject
  convenience init(_ window: NSObject) {
    self.init(windows: DisplayWindowsFixture(window))
  }
  init(windows: NSObject) { self.windows = windows }
}

/// A `windows` query the runtime refuses to answer. KVC raises on a key an object does not expose
/// rather than returning nil, which is exactly how a private XCTest read fails when it renames.
private final class UnanswerableWindowsFixture: NSObject {}

/// A window whose frame resolves but whose screen key the runtime would not answer.
private final class ScreenlessWindowFixture: NSObject {
  @objc let exists: Bool = true
  @objc var frame: CGRect { CGRect(x: 0, y: 0, width: 951, height: 669) }
}

/// A window whose frame key the runtime would not answer. The gesture path holds this object across
/// a command boundary, so a frame read that raises must fail closed inside the resolver.
private final class FramelessWindowFixture: NSObject {
  @objc let exists: Bool = true
}

extension RunnerTests {
  /// The no-panel request a single-panel device sends. Every existing case below reads this: a
  /// request that names no panel keeps the historic first-window route.
  static var noPanelFixture: RunnerLitPanel { RunnerLitPanel(displayID: 0, widthPt: 0, heightPt: 0) }

  /// The Duo's lit inner panel as a request names it: the panel table reports 669x951 native points.
  static var duoInnerPanel: RunnerLitPanel { RunnerLitPanel(displayID: 3, widthPt: 669, heightPt: 951) }

  /// The inner panel's home-screen window as the runtime reports it: presented turned, so the
  /// side lengths swap and it reads 951x669.
  static let duoHomeScreenFrame = CGRect(x: 0, y: 0, width: 951, height: 669)

  fileprivate static func duoHomeScreenWindow() -> DisplayWindowFixture {
    DisplayWindowFixture(frame: duoHomeScreenFrame, displayID: 3)
  }

  /// SpringBoard's first reported window: the 226x155.3 status-bar window, on the outer panel.
  fileprivate static func springBoardStatusBarWindow() -> DisplayWindowFixture {
    DisplayWindowFixture(frame: CGRect(x: 452, y: 0, width: 226, height: 155.3), displayID: 1)
  }

  fileprivate static func application(_ windows: [NSObject]) -> DisplayApplicationFixture {
    DisplayApplicationFixture(windows: DisplayWindowsFixture(windows: windows))
  }

  /// One screen read through the full route, holding the three in-out boxes every caller declares.
  /// `screenSeed` lets a refusal case prove the resolver clears a screen object it was handed.
  fileprivate func resolveScreen(
    _ application: NSObject,
    litPanel: RunnerLitPanel,
    screenSeed: AnyObject? = nil
  ) -> (succeeded: Bool, screen: AnyObject?, displayID: UInt, failure: RunnerApplicationScreenFailure) {
    var screen = screenSeed
    var displayID: UInt = 0
    var failure = RunnerApplicationScreenFailure.none
    let succeeded = RunnerResolveApplicationScreen(
      application, litPanel, &screen, &displayID, &failure
    )
    return (succeeded, screen, displayID, failure)
  }

  /// One screen read that must refuse, and the three facts every refusal holds: the typed failure,
  /// no screen object, and no display named.
  fileprivate func assertScreenReadRefuses(
    _ application: NSObject,
    expected: RunnerApplicationScreenFailure,
    litPanel: RunnerLitPanel,
    screenMessage: String? = nil
  ) {
    let read = resolveScreen(application, litPanel: litPanel, screenSeed: NSObject())
    XCTAssertFalse(read.succeeded)
    XCTAssertEqual(read.failure, expected)
    if let screenMessage {
      XCTAssertNil(read.screen, screenMessage)
    } else {
      XCTAssertNil(read.screen)
    }
    XCTAssertEqual(read.displayID, 0, "a refusal names no display")
  }

  /// One surface walk, holding the same in-out boxes, so a case states only the shape it feeds and
  /// the window it expects back.
  fileprivate func resolveSurfaceWindow(
    _ application: NSObject,
    litPanel: RunnerLitPanel
  ) -> (failure: RunnerApplicationScreenFailure, window: AnyObject?, windowFrame: CGRect, observedFrame: CGRect) {
    var window: AnyObject?
    var windowFrame = CGRect.null
    var observedFrame = CGRect.null
    let failure = RunnerResolveSurfaceWindow(
      application, litPanel, &window, &windowFrame, &observedFrame
    )
    return (failure, window, windowFrame, observedFrame)
  }


  func testSynthesizedDisplayRoutesByTheResolvedWindow() {
    let window = DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 951, height: 669), displayID: 3)
    var displayID: UInt = 0
    XCTAssertNil(RunnerResolveWindowDisplayID(window, &displayID))
    XCTAssertEqual(displayID, 3)
    XCTAssertTrue(window.resolved, "the window path must resolve the frame before reading its screen")
  }

  func testSynthesizedDisplayPreservesPrimaryWindowIdentity() {
    let window = DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 466, height: 678), displayID: 1)
    var displayID: UInt = 0
    XCTAssertNil(RunnerResolveWindowDisplayID(window, &displayID))
    XCTAssertEqual(displayID, 1)
  }

  func testSynthesizedDisplayRefusesWindowWithoutQualifyingFrame() {
    for frame in [CGRect.zero, .null, .infinite] {
      let window = DisplayWindowFixture(frame: frame, displayID: 3)
      var displayID: UInt = 99
      XCTAssertNotNil(RunnerResolveWindowDisplayID(window, &displayID))
      XCTAssertEqual(displayID, 99)
    }
  }

  func testSynthesizedDisplayRefusesWindowWithNoDisplayIDOrNoScreenAnswer() {
    let noDisplayWindow = DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 951, height: 669), displayID: 0)
    let screenlessWindow = ScreenlessWindowFixture()
    for window in [noDisplayWindow, screenlessWindow] as [NSObject] {
      var displayID: UInt = 99
      let error = RunnerResolveWindowDisplayID(window, &displayID)
      XCTAssertNotNil(error)
      XCTAssertTrue(
        error?.contains("no resolved window display ID") ?? false,
        "expected the typed screen refusal, got \(error ?? "nil")"
      )
      XCTAssertEqual(displayID, 99)
    }
  }

  func testSynthesizedDisplayRefusesAWindowWhoseFrameLookupRaises() {
    var displayID: UInt = 99
    let reason = RunnerResolveWindowDisplayID(FramelessWindowFixture(), &displayID)
    XCTAssertNotNil(reason, "a frame read that raises must be caught, not handed to the gesture path")
    XCTAssertTrue(
      reason?.contains("no resolved application window") ?? false,
      "expected the typed window refusal, got \(reason ?? "nil")"
    )
    XCTAssertEqual(displayID, 99)
  }

  func testResolvedScreenHandsBackTheScreenTheResolvedWindowReported() {
    let window = Self.duoHomeScreenWindow()
    let read = resolveScreen(DisplayApplicationFixture(window), litPanel: Self.noPanelFixture)
    XCTAssertTrue(read.succeeded)
    XCTAssertEqual(read.displayID, 3)
    XCTAssertTrue(window.resolved, "the window's screen only answers once its query resolved")
    XCTAssertTrue(
      read.screen === window.screen,
      "the capture must go to the screen object this window reported, not a re-queried one"
    )
  }

  func testResolvedScreenRefusesAWindowLookupThatRaises() {
    assertScreenReadRefuses(
      DisplayApplicationFixture(windows: UnanswerableWindowsFixture()),
      expected: .unresolvedWindow,
      litPanel: Self.noPanelFixture
    )
  }

  func testResolvedScreenRefusesAResolvedWindowWithNoAnswerableScreen() {
    assertScreenReadRefuses(
      DisplayApplicationFixture(ScreenlessWindowFixture()),
      expected: .unresolvedScreen,
      litPanel: Self.noPanelFixture
    )
  }

  func testResolvedScreenRefusesAWindowReportingNoDisplayID() {
    let outerPanel = DisplayWindowFixture(
      frame: CGRect(x: 0, y: 0, width: 466, height: 678), displayID: 0)
    assertScreenReadRefuses(
      DisplayApplicationFixture(outerPanel), expected: .unresolvedScreen, litPanel: Self.noPanelFixture
    )
  }

  func testResolvedScreenRefusesAnEmptyWindowFrameWithoutNamingAnyDisplay() {
    assertScreenReadRefuses(
      DisplayApplicationFixture(DisplayWindowFixture(frame: .zero, displayID: 3)),
      expected: .unresolvedWindow,
      litPanel: Self.noPanelFixture,
      screenMessage: "a dark panel must never become the capture target by default"
    )
  }

  /// A cold query answers `frame` with a usable rect on some runtimes while its `exists` says the
  /// window is not there. Geometry alone must not be trusted into capturing a panel nobody resolved.
  func testResolvedScreenRefusesAWindowTheQuerySaysIsNotThere() {
    let absent = DisplayWindowFixture(
      frame: Self.duoHomeScreenFrame, displayID: 3, present: false)
    assertScreenReadRefuses(
      DisplayApplicationFixture(absent), expected: .unresolvedWindow, litPanel: Self.noPanelFixture
    )
  }

  /// #2995: a `frame` read on an element the query says is not there can make XCTest record an issue,
  /// and an unmuted issue ends the runner session. The walk reads `exists` and stops there, on both
  /// routes, so a candidate that vanished between listing and reading costs one read, not two.
  func testSurfaceWalkNeverAsksAnAbsentWindowForItsFrame() {
    for panel in [Self.noPanelFixture, Self.duoInnerPanel] {
      let absent = DisplayWindowFixture(
        frame: Self.duoHomeScreenFrame, displayID: 3, present: false)
      let walk = resolveSurfaceWindow(Self.application([absent]), litPanel: panel)
      XCTAssertEqual(walk.failure, .unresolvedWindow)
      XCTAssertFalse(
        absent.resolved,
        "an absent window must not be asked for its frame (panel=\(panel.displayID))"
      )
    }
  }

  /// The panel rule's own decision, from facts alone: no queries, no device, no clock. The rows are
  /// the shapes a foldable home screen actually presents — SpringBoard's status-bar window is a
  /// 226x155.3 box, and the inner panel reports 951x669 for the 669x951 the panel table names.
  func testPanelSurfaceRuleSelectsTheWindowOnTheLitPanel() {
    let lit = RunnerLitPanel(displayID: 3, widthPt: 669, heightPt: 951)
    let statusBar = RunnerPanelWindowFact(
      displayID: 1, frame: CGRect(x: 452, y: 0, width: 226, height: 155.3))
    let home = RunnerPanelWindowFact(displayID: 3, frame: CGRect(x: 0, y: 0, width: 951, height: 669))
    var selected = RunnerPanelWindowFact(displayID: 0, frame: .null)
    var index: UInt = UInt.max

    XCTAssertEqual(
      RunnerPanelSurfaceSelectWindow([statusBar, home], 2, lit, &selected, &index),
      .litPanelWindow
    )
    XCTAssertEqual(index, 1, "the window on the lit panel wins over the one listed first")
    XCTAssertEqual(selected.displayID, 3)
    XCTAssertEqual(selected.frame, home.frame)
  }

  func testPanelSurfaceRuleAcceptsAPanelPresentedTurned() {
    // The panel table names the inner panel 669x951; the system presents it turned, so its window
    // reports 951x669. Both ways up are the same panel.
    let lit = RunnerLitPanel(displayID: 3, widthPt: 669, heightPt: 951)
    let upright = RunnerPanelWindowFact(displayID: 3, frame: CGRect(x: 0, y: 0, width: 669, height: 951))
    let turned = RunnerPanelWindowFact(displayID: 3, frame: CGRect(x: 0, y: 0, width: 951, height: 669))
    for candidate in [upright, turned] {
      let facts = [candidate]
      var selected = RunnerPanelWindowFact(displayID: 0, frame: .null)
      var index: UInt = UInt.max
      XCTAssertEqual(
        RunnerPanelSurfaceSelectWindow(facts, 1, lit, &selected, &index),
        .litPanelWindow,
        "expected \(candidate.frame) to qualify as the lit panel's surface"
      )
      XCTAssertEqual(selected.frame, candidate.frame)
      XCTAssertEqual(index, 0)
    }
  }

  func testPanelSurfaceRuleRefusesWindowsThatAreAllOffTheLitPanel() {
    // A full-screen window on the *dark* panel is the trap: geometry alone would happily book a
    // gesture on a screen nobody is looking at.
    let lit = RunnerLitPanel(displayID: 3, widthPt: 669, heightPt: 951)
    let facts = [
      RunnerPanelWindowFact(displayID: 1, frame: CGRect(x: 452, y: 0, width: 226, height: 155.3)),
      RunnerPanelWindowFact(displayID: 1, frame: CGRect(x: 0, y: 0, width: 466, height: 678)),
    ]
    var selected = RunnerPanelWindowFact(displayID: 0, frame: .null)
    var index: UInt = UInt.max
    XCTAssertEqual(
      RunnerPanelSurfaceSelectWindow(facts, 2, lit, &selected, &index),
      .offLitPanel
    )
    XCTAssertEqual(selected.displayID, 1, "a refusal reports the first window it looked at")
    XCTAssertEqual(index, 0)
  }

  func testPanelSurfaceRuleBooksTheLargestWindowPlacedOnTheLitPanel() {
    // An app that occupies part of the lit panel (Split View, a stage, a sheet) has no box equal to
    // the panel's, and being on the lit panel is still the fact a first-window walk could not
    // establish. The status-bar window is on the same display and loses on size.
    let lit = RunnerLitPanel(displayID: 3, widthPt: 669, heightPt: 951)
    let facts = [
      RunnerPanelWindowFact(displayID: 3, frame: CGRect(x: 452, y: 0, width: 226, height: 155.3)),
      RunnerPanelWindowFact(displayID: 3, frame: CGRect(x: 0, y: 90, width: 300, height: 400)),
      RunnerPanelWindowFact(displayID: 3, frame: CGRect(x: 20, y: 20, width: 120, height: 900)),
    ]
    var selected = RunnerPanelWindowFact(displayID: 0, frame: .null)
    var index: UInt = UInt.max
    XCTAssertEqual(
      RunnerPanelSurfaceSelectWindow(facts, 3, lit, &selected, &index),
      .litDisplayWindow
    )
    XCTAssertEqual(index, 1)
    XCTAssertEqual(selected.frame, CGRect(x: 0, y: 90, width: 300, height: 400))
  }

  func testPanelSurfaceRuleRefusesNoWindows() {
    let facts: [RunnerPanelWindowFact] = []
    var selected = RunnerPanelWindowFact(displayID: 7, frame: CGRect(x: 1, y: 2, width: 3, height: 4))
    var index: UInt = UInt.max
    XCTAssertEqual(
      RunnerPanelSurfaceSelectWindow(
        facts, 0, RunnerLitPanel(displayID: 3, widthPt: 669, heightPt: 951), &selected, &index),
      .noWindow
    )
    XCTAssertTrue(CGRectIsNull(selected.frame), "a refusal with nothing to report names no frame")
    XCTAssertEqual(index, UInt.max)
  }

  func testPanelSurfaceRuleRequiresTheOriginAndRejectsUnmeasurableFrames() {
    let lit = RunnerLitPanel(displayID: 1, widthPt: 466, heightPt: 678)
    XCTAssertTrue(
      RunnerPanelFrameIsLitPanelSurface(CGRect(x: 0, y: 0, width: 466, height: 678), lit)
    )
    // Half a point is rounding; a whole point is a different box.
    XCTAssertTrue(
      RunnerPanelFrameIsLitPanelSurface(CGRect(x: 0.4, y: -0.4, width: 466, height: 678), lit)
    )
    XCTAssertFalse(
      RunnerPanelFrameIsLitPanelSurface(CGRect(x: 1, y: 0, width: 466, height: 678), lit)
    )
    // The same size in the wrong place, and a panel's size on the wrong panel's shape.
    XCTAssertFalse(
      RunnerPanelFrameIsLitPanelSurface(CGRect(x: 452, y: 0, width: 466, height: 678), lit)
    )
    XCTAssertFalse(
      RunnerPanelFrameIsLitPanelSurface(CGRect(x: 0, y: 0, width: 223, height: 317), lit)
    )
    for frame in [CGRect.zero, .null, .infinite] {
      XCTAssertFalse(RunnerPanelFrameIsLitPanelSurface(frame, lit), "\(frame) is not a measurement")
    }
  }

  /// The walk the four surface paths run: with a panel, the app's first window is not the answer.
  /// The foldable home screen below is the shape that made a long press open nothing — the runtime
  /// lists SpringBoard's status-bar window first, on the dark panel.
  func testSurfaceWindowWalkWithAPanelSkipsTheFirstWindowOnTheDarkPanel() {
    let statusBar = Self.springBoardStatusBarWindow()
    let home = Self.duoHomeScreenWindow()
    let walk = resolveSurfaceWindow(Self.application([statusBar, home]), litPanel: Self.duoInnerPanel)
    XCTAssertEqual(walk.failure, .none)
    XCTAssertTrue(walk.window === home, "the surface is the window on the lit panel")
    XCTAssertEqual(walk.windowFrame, Self.duoHomeScreenFrame)
  }

  /// A request that names no panel is a single-panel device's request: the walk stops at the first
  /// window the query names and never asks a window which display it is on.
  func testSurfaceWindowWalkWithoutAPanelKeepsTheFirstWindowAndReadsNoDisplay() {
    let first = DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 390, height: 844), displayID: 1)
    let walk = resolveSurfaceWindow(Self.application([first]), litPanel: Self.noPanelFixture)
    XCTAssertEqual(walk.failure, .none)
    XCTAssertTrue(walk.window === first)
    XCTAssertEqual(walk.windowFrame, CGRect(x: 0, y: 0, width: 390, height: 844))
  }

  func testSurfaceWindowWalkRefusesAWindowOnTheDarkPanel() {
    let statusBar = Self.springBoardStatusBarWindow()
    let wallpaper = DisplayWindowFixture(
      frame: CGRect(x: 0, y: 0, width: 466, height: 678), displayID: 1)
    let walk = resolveSurfaceWindow(
      Self.application([statusBar, wallpaper]), litPanel: Self.duoInnerPanel)
    XCTAssertEqual(walk.failure, .offLitPanel, "no window is on the lit panel, so nothing may be booked")
    XCTAssertNil(walk.window, "a dark panel must never become the surface by default")
    XCTAssertEqual(walk.windowFrame, .null)
  }

  /// A window whose display the runtime will not name cannot be placed on a panel. It is skipped,
  /// and a window that does answer still resolves.
  func testSurfaceWindowWalkSkipsAWindowThatWillNotNameItsDisplay() {
    let home = Self.duoHomeScreenWindow()
    let walk = resolveSurfaceWindow(
      Self.application([ScreenlessWindowFixture(), home]), litPanel: Self.duoInnerPanel)
    XCTAssertEqual(walk.failure, .none)
    XCTAssertTrue(walk.window === home)
  }

  /// When every window that has a frame refuses to name its display, the walk has nothing to place,
  /// and the host must see the display refusal rather than a window it can retry.
  func testSurfaceWindowWalkReportsADisplayRefusalWhenNoWindowCanBePlaced() {
    let walk = resolveSurfaceWindow(
      Self.application([ScreenlessWindowFixture()]), litPanel: Self.duoInnerPanel)
    XCTAssertEqual(walk.failure, .unresolvedScreen)
    XCTAssertNil(walk.window)
  }

  func testSurfaceWindowWalkRefusesAnApplicationThatAnswersNoWindows() {
    for panel in [Self.noPanelFixture, Self.duoInnerPanel] {
      let walk = resolveSurfaceWindow(
        DisplayApplicationFixture(windows: UnanswerableWindowsFixture()), litPanel: panel)
      XCTAssertEqual(walk.failure, .unresolvedWindow)
      XCTAssertNil(walk.window)
    }
  }

  /// The full route a capture takes: the panel decides which window's `XCUIScreen` the capture uses,
  /// and it is the screen object that window reported.
  func testResolvedScreenFollowsTheLitPanelNotTheFirstWindow() {
    let statusBar = Self.springBoardStatusBarWindow()
    let home = Self.duoHomeScreenWindow()
    let read = resolveScreen(
      Self.application([statusBar, home]), litPanel: Self.duoInnerPanel)
    XCTAssertTrue(read.succeeded)
    XCTAssertEqual(read.failure, .none)
    XCTAssertEqual(read.displayID, 3, "the capture must name the lit panel, not the display listed first")
    XCTAssertTrue(read.screen === home.screen)
  }

  /// A capture's screen read is the one consumer that needs the `XCUIScreen` object; a caller that
  /// routes by display identity alone must be able to ask without one.
  func testResolvedWindowScreenAnswersDisplayIDWithoutARequestedScreen() {
    let window = Self.duoHomeScreenWindow()
    var displayID: UInt = 0
    XCTAssertEqual(
      RunnerReadResolvedWindowScreen(window, window.frame, nil, &displayID),
      .none
    )
    XCTAssertEqual(displayID, 3)
  }

  /// The walk is bounded: reading more windows than the cap would widen the risk of asking a window
  /// that has already vanished for anything (#2995).
  func testWindowElementCopyIsCappedAtThePanelWalkBudget() {
    let windows: [NSObject] = (0..<12).map {
      DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 100, height: 100), displayID: UInt($0 + 1))
    }
    let application = DisplayApplicationFixture(windows: DisplayWindowsFixture(windows: windows))
    var reported: UInt = 0
    XCTAssertEqual(RunnerCopyApplicationWindowElements(application, 8, &reported)?.count, 8)
    XCTAssertEqual(
      reported, 12, "the marker reports the list the query named, not the cap that trimmed it"
    )
    XCTAssertNotNil(RunnerCopyApplicationWindowElements(application, 20, &reported))
    XCTAssertNil(
      RunnerCopyApplicationWindowElements(
        DisplayApplicationFixture(windows: UnanswerableWindowsFixture()), 8, nil),
      "a windows query that raises answers no windows, and does not raise here"
    )
  }

  /// The sole-screen rule's decision, at the seam the production probe feeds: the values the
  /// AXRuntime probe reads in, never a device list. The windowed/unknown rows below fail without
  /// the fills-screen proof, on any family and on the macOS host lane, and each keeps its exact
  /// typed outcome — `not fills-screen` alone cannot tell windowed from unknown.
  func testFullScreenEvidenceDecidesFromForegroundValues() {
    let screen = CGRect(x: 0, y: 0, width: 834, height: 1210)
    let cases: [(name: String, targetPid: pid_t, primaryPid: pid_t, window: CGRect, screen: CGRect, expected: RunnerFullScreenEvidence)] = [
      ("same frame", 100, 100, screen, screen, .fillsScreen),
      // Sub-pixel layout rounding is not a window; it stays inside the 0.5 tolerance.
      ("0.4-pt displacement", 100, 100, screen.offsetBy(dx: 0.4, dy: -0.4), screen, .fillsScreen),
      // A window that shows the app in part of the screen (Windowed Apps or Stage Manager).
      ("placed window", 100, 100, CGRect(x: 224, y: 128, width: 386, height: 954), screen, .windowed),
      // Each component alone, so no comparison can be dropped for an equal-size shortcut.
      ("1-pt minX past the tolerance", 100, 100, screen.offsetBy(dx: 1, dy: 0), screen, .windowed),
      ("1-pt minY past the tolerance", 100, 100, screen.offsetBy(dx: 0, dy: 1), screen, .windowed),
      ("1-pt narrower", 100, 100, screen.insetBy(dx: 0.5, dy: 0), screen, .windowed),
      ("1-pt shorter", 100, 100, screen.insetBy(dx: 0, dy: 0.5), screen, .windowed),
      // A window at the origin is still potentially windowed: the origin proves nothing alone.
      ("smaller window at (0,0)", 100, 100, CGRect(x: 0, y: 0, width: 834, height: 600), screen, .windowed),
      // A different app owns the foreground, so the screen is not this app's to fill.
      ("foreign primary pid", 100, 77, screen, screen, .notPrimaryApp),
      // An unreadable pid or frame proves nothing, and the answer is Unknown, never a guess.
      ("unreadable target pid", 0, 100, screen, screen, .unknown),
      ("unreadable primary pid", 100, 0, screen, screen, .unknown),
      ("null window", 100, 100, .null, screen, .unknown),
      ("empty window", 100, 100, .zero, screen, .unknown),
      ("null screen", 100, 100, screen, .null, .unknown),
      ("empty screen", 100, 100, screen, .zero, .unknown),
      // The infinite sentinel is the framework's own "no measurement" marker (CGRectInfinite's
      // components are finite extremes), so the predicate refuses it and the answer is Unknown.
      ("infinite window", 100, 100, .infinite, screen, .unknown),
      // A non-finite frame component is a runtime that said nothing, not a window that differs:
      // the answer is Unknown, never the Windowed a comparison of the numbers would read as.
      ("NaN window origin", 100, 100, CGRect(x: CGFloat.nan, y: 0, width: 834, height: 1210), screen, .unknown),
      ("infinite screen width", 100, 100, screen, CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 1210), .unknown),
    ]
    for (name, targetPid, primaryPid, window, screenFrame, expected) in cases {
      XCTAssertEqual(
        RunnerFullScreenEvidenceFromForeground(targetPid, primaryPid, window, screenFrame),
        expected,
        name
      )
    }
  }
}
#endif
