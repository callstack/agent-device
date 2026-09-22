import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private final class DisplayScreenFixture: NSObject {
  @objc let displayID: UInt
  init(_ displayID: UInt) { self.displayID = displayID }
}

/// A window that only reports the display it was built with once its frame has been read, which is
/// when XCTest resolves the snapshot. Before that read, `screen` still names main.
private final class DisplayWindowFixture: NSObject {
  let windowFrame: CGRect
  let resolvedDisplayID: UInt
  var resolved = false
  init(frame: CGRect, displayID: UInt) {
    self.windowFrame = frame
    self.resolvedDisplayID = displayID
  }
  @objc var frame: CGRect {
    resolved = true
    return windowFrame
  }
  @objc var screen: NSObject { DisplayScreenFixture(resolved ? resolvedDisplayID : 1) }
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
}
#endif
