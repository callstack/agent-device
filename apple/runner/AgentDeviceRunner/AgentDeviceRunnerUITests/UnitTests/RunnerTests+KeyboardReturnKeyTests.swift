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
      ("Q", 5, 959, 39), ("Done", 50, 1067, 39), (" ", 5, 1121, 197), ("ż", 202, 1121, 198),
    ])
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: true, keyboardKeys: keys),
      RunnerKeyboardStatus(visible: true, returnKey: "done", returnKeyLabel: "Done")
    )
  }

  /// The dismiss decision for a control against a keyboard read, or against the keyboard's live frame
  /// alone (`keyboard: nil`) when the snapshot read failed.
  private func dismissAllowed(label: String, frame: CGRect, keyboard: RunnerKeyboardStatus.ObservedKeyboard?) -> Bool {
    RunnerKeyboardStatus.mayDismiss(
      label: label,
      frame: frame,
      keyboardFrame: keyboard?.frame ?? CGRect(x: 0, y: 609, width: 440, height: 240),
      keys: keyboard?.keys
    )
  }

  /// A keyboard read for the dismiss decision: the frame and the controls of one snapshot.
  private func observedKeyboardFixture(
    _ entries: [(text: String, x: CGFloat, y: CGFloat, width: CGFloat)],
    identifiers: [String: String] = [:],
    keyboardFrame: CGRect = CGRect(x: 0, y: 609, width: 440, height: 240)
  ) -> RunnerKeyboardStatus.ObservedKeyboard {
    var keys = observedKeyboardKeysFixture(entries)
    keys = keys.map { key in
      RunnerKeyboardStatus.ObservedKeyboardKey(
        text: key.text,
        frame: key.frame,
        identifier: key.text.flatMap { identifiers[$0] }
      )
    }
    return RunnerKeyboardStatus.ObservedKeyboard(frame: keyboardFrame, keys: keys)
  }

  /// `keyboard dismiss` never presses a `Done` that could be the return key, which submits the field:
  /// a `Done` inside the key rows is refused whether its wording is its label or only its identifier,
  /// the iPad hide-keyboard key is pressed, and a `Done` toolbar button above the key rows is pressed
  /// in preference to the return key beside the keys.
  func testKeyboardDismissNeverPressesADoneInsideTheKeyRows() {
    let phone = observedKeyboardFixture([
      ("Q", 5, 616, 41), ("space", 108, 784, 207), ("done", 314, 784, 103),
    ], identifiers: ["done": "Done"])
    XCTAssertTrue(RunnerKeyboardStatus.dismissControls(in: phone).isEmpty)
    XCTAssertFalse(
      dismissAllowed(label: "Done", frame: CGRect(x: 314, y: 784, width: 103, height: 54), keyboard: phone)
    )

    let pad = observedKeyboardFixture([
      ("Tab", 6, 905, 81), ("Q", 87, 905, 65), ("Done", 691, 969, 126), ("numbers", 622, 1096, 97),
      ("Hide keyboard", 720, 1096, 98),
    ], keyboardFrame: CGRect(x: 0, y: 880, width: 834, height: 300))
    XCTAssertEqual(RunnerKeyboardStatus.dismissControls(in: pad).first?.text, "Hide keyboard")

    let withToolbar = observedKeyboardFixture([
      ("Done", 330, 524, 63), ("Q", 5, 616, 41), ("space", 108, 784, 207), ("done", 314, 784, 103),
    ], identifiers: ["done": "Done"])
    let pressed = RunnerKeyboardStatus.dismissControls(in: withToolbar).first
    XCTAssertEqual(pressed?.text, "Done")
    XCTAssertEqual(pressed?.frame.minY, 524)
  }

  /// A `Done` inside the keyboard's frame but above the key rows, such as an input assistant band
  /// merged into the keyboard element, is an accessory button and is pressable; one that overlaps the
  /// key rows is refused. A hide-keyboard key just below the keyboard's top edge is pressable wherever
  /// it sits. Only a control wholly inside the keyboard is tapped through the keyboard's coordinate: a
  /// toolbar above it has no valid offset there and is tapped through its own element.
  func testKeyboardDismissAdmitsAnAccessoryDoneInsideTheKeyboardFrameAboveTheKeyRows() {
    let keyboard = observedKeyboardFixture([
      ("Done", 330, 612, 63), ("Q", 5, 666, 41), ("space", 108, 784, 207),
      ("Hide keyboard", 380, 612, 50),
    ])
    let band = CGRect(x: 330, y: 612, width: 63, height: 40)
    XCTAssertTrue(dismissAllowed(label: "Done", frame: band, keyboard: keyboard))
    XCTAssertFalse(
      dismissAllowed(
        label: "Done",
        frame: CGRect(x: 330, y: 640, width: 63, height: 54),
        keyboard: keyboard
      )
    )
    XCTAssertTrue(
      dismissAllowed(
        label: "Hide keyboard",
        frame: CGRect(x: 380, y: 612, width: 50, height: 54),
        keyboard: keyboard
      )
    )
  }

  /// A control is tapped by identity, so it must be the only control of its type with its dismiss
  /// wording: a second one, or the same wording on a button against a key, is a different control.
  func testKeyboardDismissTapsOnlyAControlItCanTellApart() {
    let hide = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "Hide keyboard", frame: CGRect(x: 720, y: 1096, width: 98, height: 54)
    )
    let twin = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "Hide keyboard", frame: CGRect(x: 20, y: 1096, width: 98, height: 54)
    )
    let hideButton = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "Hide keyboard", frame: CGRect(x: 400, y: 1096, width: 98, height: 54), kind: .button
    )
    let identified = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "done", frame: CGRect(x: 314, y: 784, width: 103, height: 54), identifier: "Done"
    )
    XCTAssertTrue(RunnerKeyboardStatus.isUniqueDismissControl(hide, in: [hide]))
    XCTAssertTrue(RunnerKeyboardStatus.isUniqueDismissControl(hide, in: [hide, hideButton]))
    XCTAssertFalse(RunnerKeyboardStatus.isUniqueDismissControl(hide, in: [hide, twin]))
    XCTAssertTrue(RunnerKeyboardStatus.isUniqueDismissControl(identified, in: [identified, hide]))
    // A toolbar `Done` and a return key labelled `done` with the identifier `Done` are two controls.
    let toolbarDone = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "Done", frame: CGRect(x: 330, y: 524, width: 63, height: 38), kind: .button
    )
    let returnKey = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "done", frame: CGRect(x: 314, y: 784, width: 103, height: 56), identifier: "Done", kind: .button
    )
    XCTAssertTrue(RunnerKeyboardStatus.isUniqueDismissControl(toolbarDone, in: [toolbarDone, returnKey]))
    XCTAssertNil(RunnerKeyboardStatus.dismissLabel(of: RunnerKeyboardStatus.ObservedKeyboardKey(text: "Q", frame: .zero)))
  }

  /// A control that cannot be told apart is skipped, not fatal: with two `Hide keyboard` keys and a
  /// `Done` toolbar above the key rows, the unique `Done` is still pressed, and with nothing unique
  /// left nothing is.
  func testKeyboardDismissTriesTheNextControlWhenOneCannotBeToldApart() {
    let twinHides = observedKeyboardFixture([
      ("Done", 330, 524, 63), ("Q", 5, 616, 41), ("Hide keyboard", 700, 1096, 98),
      ("Hide keyboard", 20, 1096, 98),
    ], keyboardFrame: CGRect(x: 0, y: 609, width: 834, height: 600))
    XCTAssertEqual(
      RunnerKeyboardStatus.dismissControls(in: twinHides).map(\.text),
      ["Hide keyboard", "Hide keyboard", "Done"]
    )
    XCTAssertEqual(RunnerKeyboardStatus.uniqueDismissControls(in: twinHides).map(\.text), ["Done"])

    let onlyTwins = observedKeyboardFixture([
      ("Q", 5, 616, 41), ("Hide keyboard", 700, 1096, 98), ("Hide keyboard", 20, 1096, 98),
    ], keyboardFrame: CGRect(x: 0, y: 609, width: 834, height: 600))
    XCTAssertTrue(RunnerKeyboardStatus.uniqueDismissControls(in: onlyTwins).isEmpty)
  }

  /// A navigation bar's `Done` with the same label and identifier as the toolbar `Done` above the key
  /// rows is in another container, so it does not make the toolbar `Done` ambiguous: dismiss presses
  /// the toolbar one, which is looked up inside the toolbar alone. Two `Done` buttons in the same
  /// container stay ambiguous and are not pressed.
  func testKeyboardDismissPressesAToolbarDoneBesideAFarAwayDoneWithTheSameIdentity() {
    let navigationBarDone = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "Done", frame: CGRect(x: 330, y: 60, width: 63, height: 38), kind: .button, container: .app
    )
    let toolbarDone = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "Done", frame: CGRect(x: 330, y: 524, width: 63, height: 38), kind: .button, container: .toolbar
    )
    let keys =
      [navigationBarDone, toolbarDone]
      + observedKeyboardKeysFixture([("Q", 5, 616, 41), ("space", 108, 784, 207), ("done", 314, 784, 103)])
    let keyboard = RunnerKeyboardStatus.ObservedKeyboard(frame: CGRect(x: 0, y: 609, width: 440, height: 240), keys: keys)
    XCTAssertEqual(RunnerKeyboardStatus.uniqueDismissControls(in: keyboard).map(\.frame), [toolbarDone.frame])
    XCTAssertEqual(RunnerKeyboardStatus.uniqueDismissControls(in: keyboard).map(\.container), [.toolbar])
    // Two Done buttons in the toolbar remain ambiguous.
    let toolbarTwin = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "Done", frame: CGRect(x: 20, y: 524, width: 63, height: 38), kind: .button, container: .toolbar
    )
    let twins = RunnerKeyboardStatus.ObservedKeyboard(frame: keyboard.frame, keys: [toolbarTwin] + keys)
    XCTAssertTrue(RunnerKeyboardStatus.uniqueDismissControls(in: twins).isEmpty)
  }

  /// A dismiss control that resolves but is covered or off screen is passed over for the next eligible
  /// one, and with none tappable the answer is a refusal. Missing or empty identifiers are one thing.
  func testKeyboardDismissSkipsACoveredControlAndRefusesWhenNoneIsTappable() {
    let covered = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "Hide keyboard", frame: CGRect(x: 700, y: 1096, width: 98, height: 54)
    )
    let toolbarDone = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "Done", frame: CGRect(x: 330, y: 524, width: 63, height: 38), kind: .button
    )
    let hittable: Set<String> = ["Done"]
    let tapped = RunnerKeyboardStatus.firstTappable(
      in: [covered, toolbarDone], resolve: { $0.text }, isTappable: { hittable.contains($0) }
    )
    XCTAssertEqual(tapped, "Done")
    XCTAssertNil(
      RunnerKeyboardStatus.firstTappable(in: [covered, toolbarDone], resolve: { $0.text }, isTappable: { _ in false })
    )
    XCTAssertNil(
      RunnerKeyboardStatus.firstTappable(in: [covered], resolve: { _ in String?.none }, isTappable: { _ in true })
    )

    let noIdentifier = RunnerKeyboardStatus.ObservedKeyboardKey(text: "Done", frame: .zero)
    let emptyIdentifier = RunnerKeyboardStatus.ObservedKeyboardKey(text: "Done", frame: .zero, identifier: "")
    XCTAssertFalse(RunnerKeyboardStatus.isUniqueDismissControl(noIdentifier, in: [noIdentifier, emptyIdentifier]))
    XCTAssertEqual(RunnerKeyboardStatus.lookupFormat(of: noIdentifier).format, "label == %@")
    XCTAssertEqual(RunnerKeyboardStatus.lookupFormat(of: emptyIdentifier).format, "label == %@")
    XCTAssertEqual(
      RunnerKeyboardStatus.lookupFormat(
        of: RunnerKeyboardStatus.ObservedKeyboardKey(text: "done", frame: .zero, identifier: "Done")
      ).arguments,
      ["done", "Done"]
    )
  }

  /// A QuickType candidate is a button in the prediction bar above the key rows, so a one-letter one
  /// such as `I` or `A` must not pull the key-row anchor up to the bar: only keys anchor. With it
  /// anchored on the bar, a `Done` in the key rows could look like an accessory button and be pressed.
  func testKeyboardRowAnchorIgnoresAOneLetterQuickTypeCandidate() {
    let candidate = RunnerKeyboardStatus.ObservedKeyboardKey(
      text: "I", frame: CGRect(x: 150, y: 560, width: 60, height: 40), kind: .button
    )
    let keys =
      [candidate]
      + observedKeyboardKeysFixture([("Q", 5, 666, 41), ("space", 108, 784, 207), ("done", 314, 784, 103)])
    XCTAssertEqual(RunnerKeyboardStatus.characterKeyRowTop(in: keys), 666)
    let keyboard = RunnerKeyboardStatus.ObservedKeyboard(frame: CGRect(x: 0, y: 549, width: 440, height: 300), keys: keys)
    XCTAssertFalse(
      dismissAllowed(label: "Done", frame: CGRect(x: 314, y: 784, width: 103, height: 54), keyboard: keyboard)
    )
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: true, keyboardKeys: keys),
      RunnerKeyboardStatus(visible: true, returnKey: "done", returnKeyLabel: "done")
    )
    // With nothing but the candidate to anchor on, there is no anchor at all.
    XCTAssertNil(RunnerKeyboardStatus.characterKeyRowTop(in: [candidate]))
  }

  private func anchoredFixtureForReach() -> RunnerKeyboardStatus.ObservedKeyboard {
    observedKeyboardFixture([("Q", 5, 616, 41)])
  }

  /// Dismiss fails closed. With the keyboard unread, or read with no character key to place a `Done`
  /// against, or with a toolbar button too far above the keyboard to belong to it, only a hide-keyboard
  /// control may be pressed and no `Done` is: any of them might be the return key.
  func testKeyboardDismissFailsClosedWhenTheReturnKeyCannotBeTold() {
    let doneFrame = CGRect(x: 330, y: 524, width: 63, height: 54)
    XCTAssertFalse(dismissAllowed(label: "Done", frame: doneFrame, keyboard: nil))
    let hideFrame = CGRect(x: 380, y: 789, width: 50, height: 50)
    XCTAssertTrue(dismissAllowed(label: "Hide keyboard", frame: hideFrame, keyboard: nil))
    XCTAssertTrue(dismissAllowed(label: "Dismiss keyboard", frame: hideFrame, keyboard: nil))
    // An app button with a hide wording far from the keyboard is not the keyboard's, on any read.
    let farAway = CGRect(x: 20, y: 100, width: 80, height: 40)
    XCTAssertFalse(dismissAllowed(label: "Hide keyboard", frame: farAway, keyboard: nil))
    XCTAssertFalse(dismissAllowed(label: "Dismiss keyboard", frame: farAway, keyboard: anchoredFixtureForReach()))
    XCTAssertFalse(dismissAllowed(label: "Hide keyboard", frame: CGRect(x: 20, y: 900, width: 80, height: 40), keyboard: nil))

    let unanchored = observedKeyboardFixture([("Done", 330, 524, 63), ("space", 108, 784, 207), ("done", 314, 784, 103)])
    XCTAssertTrue(RunnerKeyboardStatus.dismissControls(in: unanchored).isEmpty)
    XCTAssertFalse(dismissAllowed(label: "Done", frame: doneFrame, keyboard: unanchored))

    let anchored = observedKeyboardFixture([("Q", 5, 616, 41)])
    XCTAssertTrue(dismissAllowed(label: "Done", frame: doneFrame, keyboard: anchored))
    XCTAssertFalse(
      dismissAllowed(label: "Done", frame: CGRect(x: 330, y: 300, width: 63, height: 54), keyboard: anchored)
    )
  }

  /// An input accessory toolbar's `Next` or `Done` that the keyboard exposes beside its keys sits above
  /// the first key row, so it is never the return key: the real return key is still named. With no
  /// character key to place it against, wording alone names nothing, so a pad whose only `Done` is a
  /// toolbar button, and a keyboard read without character keys, have no return key.
  func testKeyboardReturnControlIgnoresAnAccessoryToolbarAboveTheKeys() {
    let phone = observedKeyboardKeysFixture([
      ("Next", 20, 524, 60), ("Q", 5, 616, 41), ("W", 46, 616, 41), (" ", 108, 784, 207),
      ("done", 314, 784, 103),
    ])
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: true, keyboardKeys: phone),
      RunnerKeyboardStatus(visible: true, returnKey: "done", returnKeyLabel: "done")
    )

    let pad = observedKeyboardKeysFixture([
      ("Done", 300, 524, 90), ("1", 5, 881, 132), ("2", 136, 881, 132), ("Delete", 268, 1043, 132),
    ])
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: true, keyboardKeys: pad),
      RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: nil)
    )

    let unanchored = observedKeyboardKeysFixture([("Done", 300, 524, 90), ("space", 108, 784, 207)])
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(visible: true, keyboardKeys: unanchored),
      RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: nil)
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

#if os(iOS)
  /// One snapshot of the keyboard answers the whole read, so the walk has to reach keys nested below
  /// the keyboard's own children, answer keys before buttons the way two per-type queries did, keep the
  /// whitespace-only space bar, and drop what carries no wording or is not a key or a button.
  @MainActor
  func testObservedKeyboardKeysReadsKeysThenButtonsFromOneKeyboardSnapshot() {
    let frame = CGRect(x: 0, y: 0, width: 40, height: 40)
    let keyboard = ElementAttributesFixture(.keyboard, frame, children: [
      ElementAttributesFixture(.other, frame, children: [
        ElementAttributesFixture(.key, frame, label: "q"),
        ElementAttributesFixture(.button, frame, label: "shift"),
        ElementAttributesFixture(.key, frame, label: ""),
      ]),
      ElementAttributesFixture(.key, frame, label: " "),
      ElementAttributesFixture(.staticText, frame, label: "ignored"),
      ElementAttributesFixture(.button, frame, label: "Next:"),
    ])
    XCTAssertEqual(observedKeyboardKeys(in: keyboard).map(\.text), ["q", " ", "shift", "Next:"])
  }
#endif

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
