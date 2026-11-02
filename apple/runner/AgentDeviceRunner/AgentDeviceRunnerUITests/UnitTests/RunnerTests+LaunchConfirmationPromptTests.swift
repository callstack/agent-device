import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  private static let launchConfirmationWordings = [
    RunnerLaunchConfirmationPrompt.Wording(titleFormat: "Open in “%@”?", open: "Open", cancel: "Cancel"),
    RunnerLaunchConfirmationPrompt.Wording(titleFormat: "Ouvrir dans «\u{00A0}%@\u{00A0}»\u{00A0}?", open: "Ouvrir", cancel: "Annuler"),
    RunnerLaunchConfirmationPrompt.Wording(titleFormat: "“%@”で開きますか?", open: "開く", cancel: "キャンセル")
  ]

  /// The confirmation is recognized in each language its wordings carry, and only as a whole: the
  /// title, and both buttons of that one language.
  func testLaunchConfirmationIsRecognizedInEveryWordingLanguage() {
    let prompt = RunnerLaunchConfirmationPrompt(wordings: Self.launchConfirmationWordings)
    XCTAssertTrue(prompt.recognizes(title: "Open in “Test App”?", buttons: ["Cancel", "Open"]))
    XCTAssertTrue(prompt.recognizes(title: "Ouvrir dans «\u{00A0}Modèle RN\u{00A0}»\u{00A0}?", buttons: ["Annuler", "Ouvrir"]))
    XCTAssertTrue(prompt.recognizes(title: "“テスト”で開きますか?", buttons: ["キャンセル", "開く"]))
  }

  /// The closest negatives: an English prompt of another wording, a prompt with a foreign button,
  /// buttons from two languages, and a title that only starts like the confirmation.
  func testLaunchConfirmationRefusesAlertsThatOnlyResembleIt() {
    let prompt = RunnerLaunchConfirmationPrompt(wordings: Self.launchConfirmationWordings)
    XCTAssertFalse(prompt.recognizes(title: "“Test App” Would Like to Send You Notifications", buttons: ["Don’t Allow", "Allow"]))
    XCTAssertFalse(prompt.recognizes(title: "Ouvrir dans «\u{00A0}Modèle RN\u{00A0}»\u{00A0}?", buttons: ["Annuler", "Autoriser"]))
    XCTAssertFalse(prompt.recognizes(title: "Ouvrir dans «\u{00A0}Modèle RN\u{00A0}»\u{00A0}?", buttons: ["Cancel", "Ouvrir"]))
    XCTAssertFalse(prompt.recognizes(title: "Ouvrir dans «\u{00A0}Modèle RN\u{00A0}»\u{00A0}?", buttons: ["Annuler", "Ouvrir", "Plus tard"]))
    XCTAssertFalse(prompt.recognizes(title: "Open in “Test App”? Really", buttons: ["Cancel", "Open"]))
    XCTAssertFalse(RunnerLaunchConfirmationPrompt.unavailable.recognizes(title: "Open in “Test App”?", buttons: ["Cancel", "Open"]))
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS) && targetEnvironment(simulator)
extension RunnerTests {
  /// The OS's own SchemeApproval strings supply the wording: a French or Japanese device reads the
  /// confirmation, and `accept` picks its open button where the English labels cannot.
  func testSystemStringsRecognizeAndAnswerTheLocalizedLaunchConfirmation() {
    let languages = ["fr-FR", "ja-JP", "fi-FI"]
    let prompt = RunnerLaunchConfirmationPrompt.fromSystemStrings(languages: languages)
    let vocabulary = RunnerAlertLabelVocabulary.fromSystemStrings(languages: languages)

    XCTAssertTrue(prompt.recognizes(title: "Ouvrir dans «\u{00A0}Modèle RN\u{00A0}»\u{00A0}?", buttons: ["Annuler", "Ouvrir"]))
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["Annuler", "Ouvrir"], action: "accept", vocabulary: vocabulary), 1)
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["Annuler", "Ouvrir"], action: "dismiss", vocabulary: vocabulary), 0)

    XCTAssertTrue(prompt.recognizes(title: "“テスト”で開きますか?", buttons: ["キャンセル", "開く"]))
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["キャンセル", "開く"], action: "accept", vocabulary: vocabulary), 1)

    XCTAssertTrue(prompt.recognizes(title: "Avataanko Testi-apissa?", buttons: ["Kumoa", "Avaa"]))
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["Kumoa", "Avaa"], action: "accept", vocabulary: vocabulary), 1)

    XCTAssertFalse(prompt.recognizes(title: "Öffnen in „Test“?", buttons: ["Abbrechen", "Öffnen"]), "German is not preferred")
  }

  /// English stays recognized on an English device, and the English labels still answer it.
  func testSystemStringsStillRecognizeTheEnglishLaunchConfirmation() {
    let prompt = RunnerLaunchConfirmationPrompt.fromSystemStrings(languages: ["en-US"])
    let vocabulary = RunnerAlertLabelVocabulary.fromSystemStrings(languages: ["en-US"])
    XCTAssertTrue(prompt.recognizes(title: "Open in “Test App”?", buttons: ["Cancel", "Open"]))
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["Cancel", "Open"], action: "accept", vocabulary: vocabulary), 1)
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  /// A wording with no app-name placeholder would match a title with no app name, and a positional
  /// placeholder still marks the app-name slot.
  func testLaunchConfirmationWordingNeedsAnAppNameSlot() {
    let withoutSlot = RunnerLaunchConfirmationPrompt(wordings: [
      .init(titleFormat: "Open in the app?", open: "Open", cancel: "Cancel")
    ])
    XCTAssertFalse(withoutSlot.recognizes(title: "Open in the app?", buttons: ["Cancel", "Open"]))

    let positional = RunnerLaunchConfirmationPrompt(wordings: [
      .init(titleFormat: "Open in “%1$@”?", open: "Open", cancel: "Cancel")
    ])
    XCTAssertTrue(positional.recognizes(title: "Open in “Test App”?", buttons: ["Cancel", "Open"]))
  }

  /// Apple's bracketed object format, as Finnish words the title, marks the app-name slot too,
  /// also beside a position.
  func testLaunchConfirmationWordingAcceptsBracketedObjectFormats() {
    let finnish = RunnerLaunchConfirmationPrompt(wordings: [
      .init(titleFormat: "Avataanko %[tt]@-apissa?", open: "Avaa", cancel: "Peruuta")
    ])
    XCTAssertTrue(finnish.recognizes(title: "Avataanko Agent Device Tester-apissa?", buttons: ["Peruuta", "Avaa"]))
    XCTAssertFalse(finnish.recognizes(title: "Avataanko -apissa?", buttons: ["Peruuta", "Avaa"]))

    let positional = RunnerLaunchConfirmationPrompt(wordings: [
      .init(titleFormat: "Avataanko %1$[tt]@-apissa?", open: "Avaa", cancel: "Peruuta")
    ])
    XCTAssertTrue(positional.recognizes(title: "Avataanko Testi-apissa?", buttons: ["Peruuta", "Avaa"]))
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS) && targetEnvironment(simulator)
extension RunnerTests {
  /// Every `SchemeApproval` localization the simulated OS installs yields a matcher that
  /// recognizes its own rendered title with its own buttons, so the next format variant fails here.
  func testEveryInstalledSchemeApprovalWordingBecomesAMatcher() throws {
    let foundationPath = "/System/Library/Frameworks/Foundation.framework"
    let foundation = try XCTUnwrap(Bundle(identifier: "com.apple.Foundation")?.bundlePath)
    let root = String(foundation.dropLast(foundationPath.count))
    let table = RunnerSystemPromptStrings.launchConfirmationTable
    let bundle = try XCTUnwrap(Bundle(path: root + table.path))
    let localizations = bundle.localizations.filter {
      $0 != "en" && $0 != "Base"
        && bundle.url(forResource: table.table, withExtension: "strings", subdirectory: nil, localization: $0) != nil
    }
    XCTAssertGreaterThan(localizations.count, 10, "the runtime installs many SchemeApproval localizations")
    let placeholder = try NSRegularExpression(pattern: "%(?:\\d+\\$)?(?:\\[[^\\]]*\\])?@")
    for localization in localizations {
      let url = try XCTUnwrap(
        bundle.url(forResource: table.table, withExtension: "strings", subdirectory: nil, localization: localization)
      )
      let strings = try XCTUnwrap(NSDictionary(contentsOf: url) as? [String: String])
      let format = try XCTUnwrap(strings["SCHEME_APPROVAL_PROMPT_TITLE_NO_SOURCE"], localization)
      let open = try XCTUnwrap(strings["SCHEME_APPROVAL_OPEN_BUTTON"], localization)
      let cancel = try XCTUnwrap(strings["SCHEME_APPROVAL_DO_NOT_OPEN_BUTTON"], localization)
      let title = placeholder.stringByReplacingMatches(
        in: format, range: NSRange(format.startIndex..., in: format), withTemplate: "Test App"
      )
      XCTAssertNotEqual(title, format, "\(localization): the title format has an app-name slot the matcher knows")
      let prompt = RunnerLaunchConfirmationPrompt.fromSystemStrings(languages: [localization])
      XCTAssertTrue(prompt.recognizes(title: title, buttons: [cancel, open]), "\(localization): \(format)")
    }
  }

  /// Without the `SchemeApproval` table the permission prompts keep their translations; only the
  /// launch confirmation's own labels are lost.
  func testMissingSchemeApprovalTableKeepsThePermissionVocabulary() {
    let permission = RunnerSystemPromptStrings(english: ["DENY": "Don’t Allow"], localized: ["fr": ["DENY": "Refuser"]])
    let launch = RunnerSystemPromptStrings(
      english: ["SCHEME_APPROVAL_OPEN_BUTTON": "Open", "SCHEME_APPROVAL_OTHER": "Continue"],
      localized: ["fr": ["SCHEME_APPROVAL_OPEN_BUTTON": "Ouvrir", "SCHEME_APPROVAL_OTHER": "Poursuivre"]]
    )
    let missing = RunnerSystemPromptStrings.UnavailableSource(source: "CoreServices.framework")

    let without = RunnerAlertLabelVocabulary.composed(
      permission: .success([permission]), launchConfirmation: .failure(missing), languages: ["fr"]
    )
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["Refuser", "Autoriser"], action: "dismiss", vocabulary: without), 0)
    XCTAssertNil(RunnerAlertButtonChoice.buttonIndex(for: ["Annuler", "Ouvrir"], action: "accept", vocabulary: without))

    let with = RunnerAlertLabelVocabulary.composed(
      permission: .success([permission]), launchConfirmation: .success([launch]), languages: ["fr"]
    )
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["Annuler", "Ouvrir"], action: "accept", vocabulary: with), 1)
    XCTAssertNil(
      RunnerAlertButtonChoice.buttonIndex(for: ["Refuser", "Poursuivre"], action: "accept", vocabulary: with),
      "a key of the table other than its open and cancel labels adds no label"
    )

    let noPermission = RunnerAlertLabelVocabulary.composed(
      permission: .failure(missing), launchConfirmation: .success([launch]), languages: ["fr"]
    )
    XCTAssertNil(RunnerAlertButtonChoice.buttonIndex(for: ["Refuser", "Autoriser"], action: "dismiss", vocabulary: noPermission))
  }

  /// An app alert can carry the exact wording and buttons, and `open` accepts a marked alert, so
  /// only SpringBoard's own blocking modal is marked.
  func testOnlySpringBoardsBlockingModalIsMarkedAsTheLaunchConfirmation() {
    let title = "Open in “Test App”?"
    let items = ["Cancel", "Open"]
    let foreign = XCUIApplication(bundleIdentifier: "com.example.app")
    func alert(owner: XCUIApplication, source: AlertSurfaceSource) -> RunnerAlert {
      RunnerAlert(root: owner, ownerApp: owner, buttons: [], source: source, window: nil)
    }
    XCTAssertTrue(marksLaunchConfirmation(alert(owner: springboard, source: .blockingSystemModal), title: title, items: items))
    XCTAssertFalse(marksLaunchConfirmation(alert(owner: foreign, source: .appAlert), title: title, items: items))
    XCTAssertFalse(marksLaunchConfirmation(alert(owner: foreign, source: .blockingSystemModal), title: title, items: items))
    XCTAssertFalse(marksLaunchConfirmation(alert(owner: springboard, source: .appAlert), title: title, items: items))
    XCTAssertFalse(
      marksLaunchConfirmation(alert(owner: springboard, source: .blockingSystemModal), title: "Allow Test App?", items: items)
    )
  }
}
#endif
