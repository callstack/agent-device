import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private final class DisplayScreenFixture: NSObject {
  @objc let displayID: UInt
  init(_ displayID: UInt) { self.displayID = displayID }
}

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

private final class DisplayWindowsFixture: NSObject {
  @objc let firstMatch: NSObject
  init(_ window: NSObject) { firstMatch = window }
}

private final class DisplayApplicationFixture: NSObject {
  @objc let windows: NSObject
  init(_ window: NSObject) { windows = DisplayWindowsFixture(window) }
}

extension RunnerTests {
  func testSynthesizedDisplayResolvesWindowBeforeReadingScreen() {
    let window = DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 951, height: 669), displayID: 3)
    var displayID: UInt = 0
    XCTAssertNil(RunnerResolveApplicationDisplayID(DisplayApplicationFixture(window), &displayID))
    XCTAssertEqual(displayID, 3)
    XCTAssertTrue(window.resolved)
  }

  func testSynthesizedDisplayPreservesPrimaryWindowIdentity() {
    let window = DisplayWindowFixture(frame: CGRect(x: 0, y: 0, width: 466, height: 678), displayID: 1)
    var displayID: UInt = 0
    XCTAssertNil(RunnerResolveApplicationDisplayID(DisplayApplicationFixture(window), &displayID))
    XCTAssertEqual(displayID, 1)
  }

  func testSynthesizedDisplayRefusesUnresolvedWindowAndDisplay() {
    for (frame, identifier) in [(CGRect.zero, UInt(3)), (CGRect(x: 0, y: 0, width: 951, height: 669), UInt(0))] {
      let window = DisplayWindowFixture(frame: frame, displayID: identifier)
      var displayID: UInt = 99
      XCTAssertNotNil(RunnerResolveApplicationDisplayID(DisplayApplicationFixture(window), &displayID))
      XCTAssertEqual(displayID, 99)
    }
  }
}
#endif
