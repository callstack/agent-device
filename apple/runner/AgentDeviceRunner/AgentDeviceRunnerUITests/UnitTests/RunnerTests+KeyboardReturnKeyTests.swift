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

  /// What a `keyboard status` read builds from each observation. The visible keyboard's return
  /// control decides both fields: its wording names the kind through the same rule `keyboard enter`
  /// probes with, and it is kept as the accessibility tree carries it apart from surrounding
  /// whitespace, so a key this read cannot name is still readable.
  func testKeyboardStatusReportsTheObservedReturnControl() {
    let status = RunnerKeyboardStatus.observed(visible: true, returnControlText: " Search ")
    XCTAssertEqual(status, RunnerKeyboardStatus(visible: true, returnKey: "search", returnKeyLabel: "Search"))
  }

  /// The kinds `kind(of:)` names but the press list never probes are reported by the read, because
  /// the read looks at the keyboard's own keys rather than looking a control up by English name.
  func testKeyboardStatusReportsAKindThePressProbeListOmits() {
    for (label, kind) in [("Route", "route"), ("Continue", "continue")] {
      XCTAssertEqual(
        RunnerKeyboardStatus.observed(visible: true, returnControlText: label),
        RunnerKeyboardStatus(visible: true, returnKey: kind, returnKeyLabel: label),
        label
      )
      XCTAssertFalse(
        RunnerKeyboardReturnKey.probeLabels.contains(label),
        "\(label) must stay out of the press probe list, which the read does not use"
      )
    }
  }

  /// A hidden keyboard reports no return key at all. That is a different fact from one it could not
  /// name, so both fields stay out rather than answering `unknown` for a key nobody can press. The
  /// keyboard's keys are ignored: nothing is being submitted to.
  func testKeyboardStatusReportsNoReturnKeyWhileTheKeyboardIsHidden() {
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: false, returnControlText: "Search"),
      RunnerKeyboardStatus(visible: false, returnKey: nil, returnKeyLabel: nil)
    )
    XCTAssertEqual(
      RunnerKeyboardStatus
        .observed(visible: false, keyboardKeys: [RunnerKeyboardStatus.ObservedKeyboardKey(text: "Done", frame: CGRect(x: 0, y: 0, width: 40, height: 40))]),
      RunnerKeyboardStatus(visible: false, returnKey: nil, returnKeyLabel: nil)
    )
  }

  /// The English keyboard, as the accessibility tree carries it: the space bar's wording is a space,
  /// and the search field's return key reads `Search` in the slot beside it. The picker names the kind
  /// from the key's own wording, so the slot never has to be consulted here.
  func testKeyboardStatusPicksTheReturnKeyFromTheKeyboardKeysByWording() {
    let keys = observedKeyboardKeysFixture([
      ("Q", 5, 959, 39), ("W", 44, 959, 40), ("shift", 5, 1067, 51), ("delete", 348, 1067, 52),
      ("Numbers", 5, 1121, 49), ("Emoji", 54, 1121, 49), (" ", 103, 1121, 197),
      ("Search", 301, 1121, 99), ("Padding-Right", 0, 952, 0),
    ])
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: true, keyboardKeys: keys),
      RunnerKeyboardStatus(visible: true, returnKey: "search", returnKeyLabel: "Search")
    )
  }

  /// The whole point of reading the keyboard's own keys: a fully localized keyboard names no kind, so
  /// the return key is the control in the slot beside the space bar and its wording is reported even
  /// though the kind is `unknown`. These are the frames this read measured on a Polish iOS keyboard,
  /// where `szukaj` shares the space bar's row immediately right of it, and the letter, shift and
  /// delete keys are in higher rows.
  func testKeyboardStatusReportsALocalizedReturnKeyWithItsOwnWording() {
    let keys = observedKeyboardKeysFixture([
      ("Padding-Left", 0, 952, 0), ("Q", 5, 959, 39), ("P", 360, 959, 40), ("shift", 5, 1067, 51),
      ("M", 301, 1067, 40), ("usuń", 348, 1067, 52), ("cyfry", 5, 1121, 49), ("Emoji", 54, 1121, 49),
      (" ", 103, 1121, 197), ("szukaj", 301, 1121, 99),
    ])
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: true, keyboardKeys: keys),
      RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: "szukaj")
    )
  }

  /// A number, decimal or phone pad has no return key, and it has no space bar: the frames below are
  /// the phone pad this read measured on iOS 26.2, where `Delete` occupies the bottom-trailing corner.
  /// That corner is not a return key, and taking it would tell a caller an OTP or phone field has one.
  /// Without the space bar there is no slot, so the answer is `unknown` with no label.
  func testKeyboardStatusReportsNoLabelForAPadWithNoSpaceBar() {
    let keys = observedKeyboardKeysFixture([
      ("1", 5, 881, 132), ("2", 136, 881, 132), ("3", 268, 881, 132), ("4", 5, 935, 132),
      ("5", 136, 935, 132), ("6", 268, 935, 132), ("7", 5, 989, 132), ("8", 136, 989, 132),
      ("9", 268, 989, 132), ("Shift", 5, 1043, 132), ("0", 136, 1043, 132), ("Delete", 268, 1043, 132),
    ])
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: true, keyboardKeys: keys),
      RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: nil)
    )
  }

  /// The dictation and input-language keys, measured on an iPhone and an iPad layout: all of them sit
  /// left of the space bar, so the slot right of it still resolves to the localized return key.
  func testKeyboardStatusNeverReportsADictationOrLanguageKeyAsTheReturnKey() {
    let localized = observedKeyboardKeysFixture([
      ("Globe", 5, 1121, 49), ("Dictation", 54, 1121, 49), (" ", 103, 1121, 197),
      ("szukaj", 301, 1121, 99),
    ])
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: true, keyboardKeys: localized),
      RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: "szukaj")
    )
  }

  /// The iPad full keyboard, at the frames this read measured on iPadOS 26.2: right of the space bar
  /// sits a numbers key and then the hide-keyboard key, while the return key ends a higher row. So the
  /// space bar's right neighbour is not its row's trailing key, the slot has no candidate, and a
  /// localized keyboard whose return wording this read cannot map answers `unknown` with no label
  /// rather than reporting the numbers key as a return key. An English iPad keyboard is still named by
  /// wording, because its return key reads `search`.
  func testKeyboardStatusReportsNoLabelForAnIPadBottomRowThatDoesNotEndWithTheReturnKey() {
    let keys = observedKeyboardKeysFixture([
      ("Tab", 6, 905, 81), ("Q", 87, 905, 65), ("delete", 737, 905, 81),
      ("Caps Lock", 6, 969, 100.5), ("A", 106.5, 969, 65), ("szukaj", 691.5, 969, 126.5),
      ("shift", 6, 1032, 130), ("Z", 136, 1032, 65), ("shift", 720.5, 1032, 97.5),
      ("Next keyboard", 6, 1096, 69), ("numbers", 75, 1096, 68.5), ("Dictate", 143.5, 1096, 69),
      (" ", 212.5, 1096, 410), ("numbers", 622.5, 1096, 97.5), ("Hide keyboard", 720, 1096, 98),
    ])
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: true, keyboardKeys: keys),
      RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: nil)
    )
  }

  /// Wording outranks the slot: a key `kind(of:)` names is reported even when the slot holds something
  /// else, so a keyboard that localizes some keys and not others is still named by wording. The slot is
  /// populated here, which is what makes this a real preference rather than the only candidate.
  func testKeyboardStatusPrefersNamedWordingOverTheSlot() {
    let keys = observedKeyboardKeysFixture([
      ("Done", 5, 959, 39), (" ", 5, 1121, 197), ("ż", 202, 1121, 198),
    ])
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: true, keyboardKeys: keys),
      RunnerKeyboardStatus(visible: true, returnKey: "done", returnKeyLabel: "Done")
    )
  }

  /// A visible keyboard with no return control this read can identify answers `unknown` with no label:
  /// nothing observed, only keys with no wording (a headless test IME), a space bar with nothing beside
  /// it, and wording carried only by a zero-frame padding element.
  func testKeyboardStatusReportsUnknownForAVisibleKeyboardWithNoReadableKey() {
    let expected = RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: nil)
    XCTAssertEqual(RunnerKeyboardStatus.observed(visible: true, keyboardKeys: []), expected)
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(
        visible: true,
        keyboardKeys: observedKeyboardKeysFixture([("1", 5, 881, 132), ("2", 136, 881, 132)])
      ),
      expected
    )
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(
        visible: true,
        keyboardKeys: observedKeyboardKeysFixture([(" ", 103, 1121, 197)])
      ),
      expected
    )
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(
        visible: true,
        keyboardKeys: observedKeyboardKeysFixture([(" ", 5, 1121, 197), ("szukaj", 0, 952, 0)])
      ),
      expected
    )
  }

  /// The press path is unchanged by what the read can see: it still looks its own labels up in its
  /// own order, and the read never consults that list.
  func testKeyboardEnterProbeListStillOwnsItsOrder() {
    XCTAssertEqual(
      RunnerKeyboardReturnKey.probeLabels,
      ["return", "Return", "Enter", "Go", "Search", "Next", "Done", "Send", "Join"]
    )
  }

  /// A key whose wording the rule does not recognize keeps its wording, which is the whole point of
  /// reporting the label: a localized or a custom key stays readable where the kind is `unknown`. The
  /// caller has already established the control is the return key, so any wording on it is the label.
  func testKeyboardStatusKeepsAnUnrecognizedLabelVerbatim() {
    for label in ["Send Message", "搜索", "完了"] {
      let status = RunnerKeyboardStatus.observed(visible: true, returnControlText: label)
      XCTAssertEqual(status.returnKey, "unknown", label)
      XCTAssertEqual(status.returnKeyLabel, label)
    }
  }

  /// Builds a keyboard's observed controls from the frames this read measured; a zero width is an
  /// element with no usable frame, such as the padding entries a keyboard exposes.
  private func observedKeyboardKeysFixture(
    _ entries: [(text: String, x: CGFloat, y: CGFloat, width: CGFloat)]
  ) -> [RunnerKeyboardStatus.ObservedKeyboardKey] {
    entries.map { entry in
      RunnerKeyboardStatus.ObservedKeyboardKey(
        text: entry.text,
        frame: CGRect(x: entry.x, y: entry.y, width: entry.width, height: entry.width > 0 ? 54 : 0)
      )
    }
  }
}
#endif
