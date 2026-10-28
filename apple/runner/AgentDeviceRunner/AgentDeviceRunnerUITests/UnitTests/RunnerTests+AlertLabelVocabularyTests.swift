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
