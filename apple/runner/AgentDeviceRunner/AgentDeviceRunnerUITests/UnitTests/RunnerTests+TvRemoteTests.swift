import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testTvRemoteButtonMappingAcceptsSupportedNamesAndRejectsUnknown() {
    let supported = [
      ("select", "select"),
      ("SELECT", "select"),
      ("menu", "menu"),
      ("home", "home"),
      ("up", "up"),
      ("down", "down"),
      ("left", "left"),
      ("right", "right"),
    ]
    for (raw, expected) in supported {
      XCTAssertEqual(tvRemoteButton(from: raw)?.rawValue, expected)
    }

    for raw in [String?(nil), "", "volumeUp", "select "] {
      XCTAssertNil(tvRemoteButton(from: raw))
    }
  }
}
#endif
