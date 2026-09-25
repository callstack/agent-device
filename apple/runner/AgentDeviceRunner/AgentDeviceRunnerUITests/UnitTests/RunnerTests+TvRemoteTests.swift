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

  /// `focusBool` is the one reader behind `snapshotHasFocus` and `elementHasFocus`. A live element
  /// or snapshot answers both keys through KVC; the fixtures answer the same way, so the read that
  /// production performs is the read under test.
  func testFocusBoolReadsKeyboardFocusBesideTheFocusEnginesFocus() {
    XCTAssertTrue(
      focusBool(FocusFixture(hasFocus: false, hasKeyboardFocus: true)),
      "the field a software keyboard is typing into holds keyboard focus alone"
    )
    XCTAssertTrue(
      focusBool(FocusFixture(hasFocus: true, hasKeyboardFocus: false)),
      "the focus engine's focus (tvOS, keyboard navigation) still counts"
    )
    XCTAssertFalse(focusBool(FocusFixture(hasFocus: false, hasKeyboardFocus: false)))
    XCTAssertTrue(
      focusBool(KeyboardFocusOnlyFixture()),
      "an object that exposes no hasFocus key at all still reports its keyboard focus"
    )
    XCTAssertFalse(focusBool(NSObject()), "an object with neither key reads as unfocused, not as an exception")
  }
}

/// KVC-readable the way XCTest exposes an element's or a snapshot's focus attributes.
private final class FocusFixture: NSObject {
  @objc let hasFocus: NSNumber
  @objc let hasKeyboardFocus: NSNumber

  init(hasFocus: Bool, hasKeyboardFocus: Bool) {
    self.hasFocus = NSNumber(value: hasFocus)
    self.hasKeyboardFocus = NSNumber(value: hasKeyboardFocus)
  }
}

private final class KeyboardFocusOnlyFixture: NSObject {
  @objc let hasKeyboardFocus: NSNumber = true
}
#endif
