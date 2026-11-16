import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  /// Every Apple return-key type this rule maps: the key's English wording, and the wire value the
  /// host publishes for it (design Feature C: `keyboard status` reports `returnKey`). The raw value
  /// is the contract, so these assert the pair, not the case alone. `Google`, `Yahoo` and
  /// `Emergency Call` are Apple types this rule leaves unmapped on purpose; the test below pins that.
  func testKeyboardReturnKeyKindNamesEachReturnKeyType() {
    let cases: [(label: String, expected: String)] = [
      ("Go", "go"),
      ("Search", "search"),
      ("Send", "send"),
      ("Next", "next"),
      ("Done", "done"),
      ("Join", "join"),
      ("Route", "route"),
      ("Continue", "continue"),
      ("Return", "enter"),
      ("Enter", "enter"),
    ]
    for (label, expected) in cases {
      XCTAssertEqual(RunnerKeyboardReturnKey.kind(of: label).rawValue, expected, label)
    }
  }

  /// Keyboards and iOS versions differ in the label's casing and padding; the kind it names does not.
  func testKeyboardReturnKeyKindIgnoresCasingAndPadding() {
    XCTAssertEqual(RunnerKeyboardReturnKey.kind(of: "done"), .done)
    XCTAssertEqual(RunnerKeyboardReturnKey.kind(of: "DONE"), .done)
    XCTAssertEqual(RunnerKeyboardReturnKey.kind(of: " Done"), .done)
    XCTAssertEqual(RunnerKeyboardReturnKey.kind(of: "\nSend\t"), .send)
  }

  /// The three Apple return-key types this rule leaves unmapped on purpose. `Google` and `Yahoo`
  /// name a vendor rather than a submit action, and `Emergency Call` places a call: reporting any of
  /// them as a submit kind would tell a caller to submit a field whose key does something else.
  func testKeyboardReturnKeyKindLeavesBrandedAndEmergencyAppleTypesUnknown() {
    for label in ["Google", "Yahoo", "Emergency Call"] {
      XCTAssertEqual(RunnerKeyboardReturnKey.kind(of: label), .unknown, label)
    }
  }

  /// Closest negatives: a label that CONTAINS a return-key word, or is a localized or custom key's
  /// wording, is not that key. A prefix or fuzzy rule would report a "Send Message" key as `send`,
  /// or a localized "Retour" key as `enter`; both would tell a caller to submit a field whose key
  /// does something else.
  func testKeyboardReturnKeyKindLeavesAmbiguousLabelsUnknown() {
    for label in [
      "Send Message",
      "Search Messages",
      "Done Sending",
      "Next slide",
      "Go to Settings",
      "Continued",
      "Return key",
      "Retour",
      "完了",
      "",
      "   ",
    ] {
      XCTAssertEqual(RunnerKeyboardReturnKey.kind(of: label), .unknown, label)
    }
  }

  /// The two owners of the key's wording stay aligned: every label the press path probes names a
  /// kind a status read can report, so a lookup that finds a control is never a status read that
  /// answers `unknown`.
  func testEveryKeyboardReturnProbeLabelMapsToAReportedKind() {
    let expected: [String: RunnerKeyboardReturnKey] = [
      "return": .enter,
      "Return": .enter,
      "Enter": .enter,
      "Go": .go,
      "Search": .search,
      "Next": .next,
      "Done": .done,
      "Send": .send,
      "Join": .join,
    ]
    for label in RunnerKeyboardReturnKey.probeLabels {
      XCTAssertEqual(RunnerKeyboardReturnKey.kind(of: label), expected[label], label)
    }
  }
}
#endif
