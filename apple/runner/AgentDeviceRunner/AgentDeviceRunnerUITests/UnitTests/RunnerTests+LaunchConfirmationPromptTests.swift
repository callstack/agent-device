import XCTest

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
    let languages = ["fr-FR", "ja-JP"]
    let prompt = RunnerLaunchConfirmationPrompt.fromSystemStrings(languages: languages)
    let vocabulary = RunnerAlertLabelVocabulary.fromSystemStrings(languages: languages)

    XCTAssertTrue(prompt.recognizes(title: "Ouvrir dans «\u{00A0}Modèle RN\u{00A0}»\u{00A0}?", buttons: ["Annuler", "Ouvrir"]))
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["Annuler", "Ouvrir"], action: "accept", vocabulary: vocabulary), 1)
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["Annuler", "Ouvrir"], action: "dismiss", vocabulary: vocabulary), 0)

    XCTAssertTrue(prompt.recognizes(title: "“テスト”で開きますか?", buttons: ["キャンセル", "開く"]))
    XCTAssertEqual(RunnerAlertButtonChoice.buttonIndex(for: ["キャンセル", "開く"], action: "accept", vocabulary: vocabulary), 1)

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
