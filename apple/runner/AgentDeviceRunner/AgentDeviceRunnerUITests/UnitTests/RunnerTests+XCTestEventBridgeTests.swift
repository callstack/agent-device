import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private final class DisplayScreenFixture: NSObject {
  @objc let displayID: UInt
  init(_ displayID: UInt) { self.displayID = displayID }
}

/// A window that only reports the display it was built with once its frame has been read, which is
/// when XCTest resolves the snapshot. Before that read, `screen` still names main.
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

extension RunnerTests {
  func testSynthesizedDisplayRoutesByTheResolvedWindow() {
    let window = DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 951, height: 669), displayID: 3)
    var displayID: UInt = 0
    XCTAssertNil(RunnerResolveWindowDisplayID(window, &displayID))
    XCTAssertEqual(displayID, 3)
    XCTAssertTrue(window.resolved)
  }

  func testSynthesizedDisplayPreservesPrimaryWindowIdentity() {
    let window = DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 466, height: 678), displayID: 1)
    var displayID: UInt = 0
    XCTAssertNil(RunnerResolveWindowDisplayID(window, &displayID))
    XCTAssertEqual(displayID, 1)
  }

  func testSynthesizedDisplayRefusesDisplaylessWindow() {
    let window = DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 951, height: 669), displayID: 0)
    var displayID: UInt = 99
    XCTAssertNotNil(RunnerResolveWindowDisplayID(window, &displayID))
    XCTAssertEqual(displayID, 99)
  }

  func testSynthesizedDisplayRefusesWindowWithoutQualifyingFrame() {
    for frame in [CGRect.zero, .null, .infinite] {
      let window = DisplayWindowFixture(frame: frame, displayID: 3)
      var displayID: UInt = 99
      XCTAssertNotNil(RunnerResolveWindowDisplayID(window, &displayID))
      XCTAssertEqual(displayID, 99)
    }
  }

  func testFirstUsableWindowSkipsAbsentAndEmptyWindows() {
    let lit = CGRect(x: 0, y: 0, width: 402, height: 874)
    XCTAssertEqual(RunnerTests.firstUsableWindowIndex(frames: [lit]), 0)
    XCTAssertEqual(RunnerTests.firstUsableWindowIndex(frames: [nil, .zero, lit]), 2)
    XCTAssertNil(RunnerTests.firstUsableWindowIndex(frames: [nil, .zero, nil]))
    XCTAssertNil(RunnerTests.firstUsableWindowIndex(frames: []))
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
}
#endif
