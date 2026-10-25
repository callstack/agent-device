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
  init(_ window: NSObject) { firstMatch = window }
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
    let window = DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 951, height: 669), displayID: 3)
    var screen: AnyObject?
    var displayID: UInt = 0
    var failure = RunnerApplicationScreenFailure.unresolvedScreen
    XCTAssertTrue(
      RunnerResolveApplicationScreen(DisplayApplicationFixture(window), &screen, &displayID, &failure)
    )
    XCTAssertEqual(displayID, 3)
    XCTAssertTrue(window.resolved, "the window's screen only answers once its query resolved")
    XCTAssertTrue(
      screen === window.screen,
      "the capture must go to the screen object this window reported, not a re-queried one"
    )
  }

  func testResolvedScreenRefusesAWindowLookupThatRaises() {
    var screen: AnyObject? = NSObject()
    var displayID: UInt = 99
    var failure = RunnerApplicationScreenFailure.none
    XCTAssertFalse(
      RunnerResolveApplicationScreen(
        DisplayApplicationFixture(windows: UnanswerableWindowsFixture()),
        &screen,
        &displayID,
        &failure
      )
    )
    XCTAssertEqual(failure, .unresolvedWindow)
    XCTAssertNil(screen)
    XCTAssertEqual(displayID, 0)
  }

  func testResolvedScreenRefusesAResolvedWindowWithNoAnswerableScreen() {
    var screen: AnyObject? = NSObject()
    var displayID: UInt = 99
    var failure = RunnerApplicationScreenFailure.none
    XCTAssertFalse(
      RunnerResolveApplicationScreen(
        DisplayApplicationFixture(ScreenlessWindowFixture()),
        &screen,
        &displayID,
        &failure
      )
    )
    XCTAssertEqual(failure, .unresolvedScreen)
    XCTAssertNil(screen)
    XCTAssertEqual(displayID, 0)
  }

  func testResolvedScreenRefusesAWindowReportingNoDisplayID() {
    let window = DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 466, height: 678), displayID: 0)
    var screen: AnyObject? = NSObject()
    var displayID: UInt = 99
    var failure = RunnerApplicationScreenFailure.none
    XCTAssertFalse(
      RunnerResolveApplicationScreen(DisplayApplicationFixture(window), &screen, &displayID, &failure)
    )
    XCTAssertEqual(failure, .unresolvedScreen)
    XCTAssertNil(screen)
    XCTAssertEqual(displayID, 0)
  }

  func testResolvedScreenRefusesAnEmptyWindowFrameWithoutNamingAnyDisplay() {
    let window = DisplayWindowFixture(frame: .zero, displayID: 3)
    var screen: AnyObject? = NSObject()
    var displayID: UInt = 99
    var failure = RunnerApplicationScreenFailure.none
    XCTAssertFalse(
      RunnerResolveApplicationScreen(DisplayApplicationFixture(window), &screen, &displayID, &failure)
    )
    XCTAssertEqual(failure, .unresolvedWindow)
    XCTAssertNil(screen, "a dark panel must never become the capture target by default")
  }

  /// A cold query answers `frame` with a usable rect on some runtimes while its `exists` says the
  /// window is not there. Geometry alone must not be trusted into capturing a panel nobody resolved.
  func testResolvedScreenRefusesAWindowTheQuerySaysIsNotThere() {
    let window = DisplayWindowFixture(
      frame: CGRect(x: 0, y: 0, width: 951, height: 669),
      displayID: 3,
      present: false
    )
    var screen: AnyObject? = NSObject()
    var displayID: UInt = 99
    var failure = RunnerApplicationScreenFailure.none
    XCTAssertFalse(
      RunnerResolveApplicationScreen(DisplayApplicationFixture(window), &screen, &displayID, &failure)
    )
    XCTAssertEqual(failure, .unresolvedWindow)
    XCTAssertNil(screen)
    XCTAssertEqual(displayID, 0)
  }
  /// The sole-screen rule's decision, at the seam the production probe feeds: the values the
  /// AXRuntime probe reads in, never a device list. The iPad halves below fail without the
  /// fills-screen proof, on any family and on the macOS host lane.
  func testFullScreenEvidenceDecidesFromForegroundValues() {
    let screen = CGRect(x: 0, y: 0, width: 834, height: 1210)

    XCTAssertEqual(
      RunnerFullScreenEvidenceFromForeground(100, 100, screen, screen),
      .fillsScreen
    )

    // A window that shows the app in part of the screen (Windowed Apps or Stage Manager).
    let windowed = CGRect(x: 224, y: 128, width: 386, height: 954)
    XCTAssertEqual(
      RunnerFullScreenEvidenceFromForeground(100, 100, windowed, screen),
      .windowed
    )

    // Sub-pixel layout rounding is not a window; it stays inside the 0.5 tolerance.
    XCTAssertEqual(
      RunnerFullScreenEvidenceFromForeground(100, 100, screen.offsetBy(dx: 0.4, dy: -0.4), screen),
      .fillsScreen
    )
    XCTAssertNotEqual(
      RunnerFullScreenEvidenceFromForeground(100, 100, screen.offsetBy(dx: 1, dy: 0), screen),
      .fillsScreen
    )

    // A different app owns the foreground, so the screen is not this app's to fill.
    XCTAssertEqual(
      RunnerFullScreenEvidenceFromForeground(100, 77, screen, screen),
      .notPrimaryApp
    )

    // An unreadable pid or frame proves nothing, and the answer is Unknown, never a guess.
    XCTAssertEqual(
      RunnerFullScreenEvidenceFromForeground(0, 100, screen, screen),
      .unknown
    )
    XCTAssertEqual(
      RunnerFullScreenEvidenceFromForeground(100, 0, screen, screen),
      .unknown
    )
    XCTAssertEqual(
      RunnerFullScreenEvidenceFromForeground(100, 100, .null, screen),
      .unknown
    )
    XCTAssertEqual(
      RunnerFullScreenEvidenceFromForeground(100, 100, screen, .zero),
      .unknown
    )
  }

  /// The routing half of the rule off the phone idiom: anything but the phone idiom routes only on
  /// the fills-screen proof. The phone half is the caller's idiom early return, so this seam never
  /// sees a phone.
  func testSoleScreenRouteOpensOnlyOnProvedFullScreenOffThePhoneIdiom() {
    XCTAssertTrue(RunnerSoleScreenRouteOpensForEvidence(.fillsScreen))
    XCTAssertFalse(
      RunnerSoleScreenRouteOpensForEvidence(.windowed),
      "a windowed iPad app must never book a gesture on the screen frame"
    )
    XCTAssertFalse(RunnerSoleScreenRouteOpensForEvidence(.notPrimaryApp))
    XCTAssertFalse(
      RunnerSoleScreenRouteOpensForEvidence(.unknown),
      "a runtime that cannot prove the fill keeps requiring a window"
    )
  }
}
#endif
