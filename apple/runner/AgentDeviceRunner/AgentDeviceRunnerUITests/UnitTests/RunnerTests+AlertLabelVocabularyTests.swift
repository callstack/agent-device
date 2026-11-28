import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  /// A translation joins the rank of the English label it translates, so a localized prompt
  /// resolves exactly like its English original.
  func testAlertTranslationsResolveAtTheRankOfTheirEnglishLabel() {
    let vocabulary = RunnerAlertLabelVocabulary(translations: [
      (english: "Don’t Allow", localized: "Nicht erlauben"),
      (english: "Allow", localized: "Erlauben"),
      (english: "Allow Once", localized: "Einmal erlauben"),
      (english: "Allow While Using App", localized: "Beim Verwenden der App erlauben")
    ])
    let labels = ["Einmal erlauben", "Beim Verwenden der App erlauben", "Nicht erlauben"]
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: labels, action: "dismiss", vocabulary: vocabulary), 2)
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: labels, action: "accept", vocabulary: vocabulary),
      1,
      "the lasting grant outranks the one-time grant in every language"
    )
  }

  /// A translation both roles claim names no single role, so it stays neutral and the choice
  /// refuses instead of tapping a button that may authorize (#3627).
  func testAlertTranslationClaimedByBothRolesStaysNeutral() {
    let byTwoTranslations = RunnerAlertLabelVocabulary(translations: [
      (english: "Don’t Allow", localized: "Tamam"),
      (english: "OK", localized: "Tamam")
    ])
    XCTAssertNil(RunnerAlertButtonChoice.buttonIndex(for: ["Tamam"], action: "dismiss", vocabulary: byTwoTranslations))
    XCTAssertNil(RunnerAlertButtonChoice.buttonIndex(for: ["Tamam"], action: "accept", vocabulary: byTwoTranslations))

    let byAnEnglishLabel = RunnerAlertLabelVocabulary(translations: [(english: "Don’t Allow", localized: "OK")])
    XCTAssertNil(RunnerAlertButtonChoice.buttonIndex(for: ["OK"], action: "dismiss", vocabulary: byAnEnglishLabel))
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["OK"], action: "accept", vocabulary: byAnEnglishLabel), 0)
  }

  /// The built-in table is the only vocabulary a physical device has, so every row must resolve
  /// exactly like the English label it translates: the row's action takes it, the other action
  /// refuses it, and no row names both actions (#3627). A new row joins this test's coverage
  /// without an edit here.
  func testDeviceVocabularyResolvesEachEntryLikeTheEnglishLabelItTranslates() throws {
    for translation in RunnerAlertLabelVocabulary.deviceTranslations {
      let action = try XCTUnwrap(
        RunnerAlertButtonChoice.action(of: translation.english, wholeLabel: true),
        "\(translation.english) is no whole preference label, so the row would be dropped"
      )
      let other = action == "accept" ? "dismiss" : "accept"
      XCTAssertEqual(
        RunnerAlertButtonChoice.buttonIndex(for: [translation.localized], action: action, vocabulary: .device),
        0, translation.localized
      )
      XCTAssertNil(
        RunnerAlertButtonChoice.buttonIndex(for: [translation.localized], action: other, vocabulary: .device),
        "\(translation.localized) must not name \(other)"
      )
    }
  }

  /// A Chinese device words the notification, tracking, and location prompts in labels no English
  /// entry matches, which answered ALERT_BUTTON_NOT_FOUND before the built-in table. Shipped iOS
  /// versions word the tracking decline two ways, so the same prompt is resolved for each wording.
  func testChineseDeviceVocabularyResolvesTheSystemPermissionPrompts() {
    let notifications = ["不允许", "允许"]
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: notifications, action: "dismiss", vocabulary: .device), 0)
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: notifications, action: "accept", vocabulary: .device), 1)

    for decline in ["要求App不跟踪", "要求App不追踪"] {
      let tracking = [decline, "允许"]
      XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: tracking, action: "dismiss", vocabulary: .device), 0, decline)
      XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: tracking, action: "accept", vocabulary: .device), 1, decline)
    }

    let location = ["允许一次", "使用App时允许", "不允许"]
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: location, action: "dismiss", vocabulary: .device), 2)
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: location, action: "accept", vocabulary: .device),
      1,
      "the lasting grant outranks the one-time grant in every language"
    )
  }

  /// The built-in table adds localized labels only: an English prompt resolves through the
  /// English lists exactly as without the vocabulary.
  func testDeviceVocabularyLeavesEnglishResolutionUnchanged() {
    let prompts: [[String]] = [
      ["Allow Once", "Allow While Using App", "Don't Allow"],
      ["Cancel", "OK"],
      ["Ask App Not to Track", "Allow"],
      ["Keep Browsing", "Open"]
    ]
    for labels in prompts {
      for action in ["accept", "dismiss"] {
        XCTAssertEqual(
          RunnerAlertButtonChoice.buttonIndex(for: labels, action: action, vocabulary: .device),
          RunnerAlertButtonChoice.buttonIndex(for: labels, action: action, vocabulary: .english),
          "\(action) must resolve \(labels) the same with and without the device table"
        )
      }
    }
  }

  /// A source string only translates a button label when the whole string is that label: the
  /// prefix-matched "Confirm…" family must not pull in sentences that merely start with it.
  func testAlertTranslationSourceMustBeAWholeButtonLabel() {
    let vocabulary = RunnerAlertLabelVocabulary(translations: [
      (english: "Confirm your location access in Settings", localized: "Standortzugriff bestätigen"),
      (english: "Confirm", localized: "Bestätigen")
    ])
    XCTAssertNil(
      RunnerAlertButtonChoice.buttonIndex(for: ["Standortzugriff bestätigen"], action: "accept", vocabulary: vocabulary)
    )
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["Bestätigen"], action: "accept", vocabulary: vocabulary), 0)
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS) && targetEnvironment(simulator)
extension RunnerTests {
  /// Every row of the built-in table is a pair this runtime's zh_CN strings ship, except the two
  /// wordings listed here, each shown by a different build.
  ///
  /// zh_CN words the App Tracking Transparency decline two ways and one build shows one of them:
  /// 要求App不跟踪 on the iOS 18.1 iPhone 12 Pro Max run, 要求App不追踪 in the iOS 27.0 and 27.1
  /// runtime images, read from TCC's `REQUEST_ACCESS_DENY_kTCCServiceUserTracking`
  /// (`docs/evidence/ios-zh-hans-att-wording-os-builds-2026-11-28.md`). They differ in one character,
  /// so normalization cannot bridge them and the table keeps a row for each. One runtime's read can
  /// pair at most one, so both are exempted here. The Chinese prompt test holds both rows and compiles
  /// into the nightly iOS bundle, so the exemption cannot hide a dropped row. Run 46108117499 is what
  /// the unexempted form reached: it failed 要求App不追踪 on the pinned
  /// iOS 26.2 runtime, whose strings nothing here has read, proving only that the wording was not
  /// that build's. Every other row stays held to this runtime's own strings, on a read asserted
  /// non-empty.
  func testDeviceVocabularyRowsArePairsTheOSShipsForZhHans() {
    let observedWordings: [(english: String, localized: String)] = [
      ("Ask App Not to Track", "要求App不跟踪"),
      ("Ask App Not to Track", "要求App不追踪")
    ]
    let osRows = RunnerAlertLabelVocabulary.fromSystemStrings(languages: ["zh-Hans"]).rows
    XCTAssertFalse(osRows.isEmpty, "the OS string read answered nothing, so the rows are unverified")
    for row in RunnerAlertLabelVocabulary.deviceTranslations {
      if observedWordings.contains(where: { $0.english == row.english && $0.localized == row.localized }) { continue }
      XCTAssertTrue(
        osRows.contains(where: { $0.english == row.english && $0.localized == row.localized }),
        "\(row.english) → \(row.localized) is not a pair the OS ships in zh-Hans"
      )
    }
  }

  /// The OS's own strings supply the translations: a Japanese device words the notification,
  /// tracking, and location prompts in labels no English entry matches.
  func testJapaneseSystemVocabularyResolvesTheSystemPermissionPrompts() {
    let vocabulary = RunnerAlertLabelVocabulary.fromSystemStrings(languages: ["ja-JP"])
    let notifications = ["許可しない", "許可"]
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: notifications, action: "dismiss", vocabulary: vocabulary), 0)
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: notifications, action: "accept", vocabulary: vocabulary), 1)

    let tracking = ["アプリにトラッキングしないように要求", "許可"]
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: tracking, action: "dismiss", vocabulary: vocabulary), 0)

    let location = ["1度だけ許可", "アプリの使用中は許可", "許可しない"]
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: location, action: "dismiss", vocabulary: vocabulary), 2)
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: location, action: "accept", vocabulary: vocabulary), 1)
  }

  /// Every preferred language joins the vocabulary, because iOS words a prompt in the preferred
  /// language the app localizes into, not always the first one. A language the device does not
  /// prefer stays unknown.
  func testSystemVocabularyCarriesEveryPreferredLanguageAndNoOther() {
    let vocabulary = RunnerAlertLabelVocabulary.fromSystemStrings(languages: ["fr-FR", "ja-JP"])
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["Refuser", "Autoriser"], action: "dismiss", vocabulary: vocabulary), 0)
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["許可しない", "許可"], action: "dismiss", vocabulary: vocabulary), 0)
    XCTAssertNil(
      RunnerAlertButtonChoice.buttonIndex(for: ["Nicht erlauben", "Erlauben"], action: "dismiss", vocabulary: vocabulary)
    )
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && !(os(iOS) && targetEnvironment(simulator))
extension RunnerTests {
  /// A device's runner cannot read the OS string files, so `system` is the built-in table and a
  /// device prompt resolves like its English original instead of refusing.
  func testSystemVocabularyOnADeviceIsTheBuiltInTable() {
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["不允许", "允许"], action: "accept", vocabulary: .system), 1)
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["不允许", "允许"], action: "dismiss", vocabulary: .system), 0)
  }
}
#endif
