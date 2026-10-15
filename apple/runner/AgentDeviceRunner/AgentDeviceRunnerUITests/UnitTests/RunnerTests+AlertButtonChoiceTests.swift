import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testAlertAcceptTreatsOpenAsAffirmative() {
    XCTAssertTrue(RunnerAlertButtonChoice.isAcceptButton("Open"))
  }

  func testAlertDismissPicksTheTrackingPromptDeclineLabel() {
    // The App Tracking Transparency prompt, as iOS words it in English (#3627).
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: ["Ask App Not to Track", "Allow"], action: "dismiss"),
      0
    )
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: ["Ask App Not to Track", "Allow"], action: "accept"),
      1
    )
  }

  func testAlertDismissKeepsAnUnrecognizedDeclineLabelInsteadOfReachingAnAffirmativeOne() {
    // A localization the dismiss list cannot carry: the label the accept list does not claim is
    // the only candidate that could decline, so it wins over the trailing "Allow".
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: ["App nicht verfolgen lassen", "Allow"], action: "dismiss"),
      0
    )
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: ["More info", "Allow", "OK"], action: "dismiss"),
      0
    )
  }

  func testAlertDismissRefusesAPromptWhoseEveryButtonIsAffirmative() {
    for labels in [["Allow"], ["Allow", "OK"], ["Yes", "Continue", "Done"]] {
      XCTAssertNil(
        RunnerAlertButtonChoice.buttonIndex(for: labels, action: "dismiss"),
        "dismiss must fail without a tap rather than authorize through \(labels)"
      )
    }
  }

  func testAlertDismissStillPicksTheKnownCancelLabelAndAcceptStillTakesOK() {
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: ["Cancel", "OK"], action: "dismiss"),
      0
    )
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: ["Cancel", "OK"], action: "accept"),
      1
    )
  }

  func testAlertAcceptKeepsItsGuardsOnTheDeclineLabelsItMustNotTake() {
    // A lone declining button is not an acceptance, and with a choice, accept takes the first
    // label the accept list claims.
    XCTAssertNil(RunnerAlertButtonChoice.buttonIndex(for: ["Ask App Not to Track"], action: "accept"))
    XCTAssertNil(RunnerAlertButtonChoice.buttonIndex(for: ["Cancel"], action: "accept"))
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: ["Not now", "Confirm purchase"], action: "accept"),
      1
    )
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
extension RunnerTests {
  /// The reporter's scenario end to end: `alert dismiss` on a prompt whose decline label the list
  /// did not carry, and whose affirmative button was the last one. The command's own report was
  /// `dismissed` either way, so the canary — which button the app actually answered — is the
  /// assertion that matters (#3627).
  @MainActor
  func testAlertDismissAnswersTheTrackingPromptDeclineAndNeverAuthorizes() throws {
    app.launchArguments = ["--agent-device-alert-decline-choice"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let alert = try XCTUnwrap(
      resolveAlert(app: app, deadline: Date().addingTimeInterval(RunnerTests.defaultAlertCommandTimeout))
    )
    XCTAssertEqual(alert.buttons.map(\.label).last, "Allow", "the fixture keeps the affirmative button last")

    let response = handleAlert(
      alert,
      action: "dismiss",
      deadline: Date().addingTimeInterval(RunnerTests.alertActivationDeadline)
    )

    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(app.staticTexts["agent-device-alert-decline-answer"].label, "Declined")
  }

  /// A prompt whose every button the accept rule claims has no decline to name: `dismiss` must
  /// refuse with the typed code and tap nothing, and the canary proves the prompt stayed
  /// unanswered (#3627).
  @MainActor
  func testAlertDismissRefusesAnAffirmativeOnlyPromptWithoutActivatingIt() throws {
    app.launchArguments = ["--agent-device-alert-decline-choice", "--agent-device-alert-affirmative-only"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let alert = try XCTUnwrap(
      resolveAlert(app: app, deadline: Date().addingTimeInterval(RunnerTests.defaultAlertCommandTimeout))
    )

    let response = handleAlert(
      alert,
      action: "dismiss",
      deadline: Date().addingTimeInterval(RunnerTests.alertActivationDeadline)
    )

    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "ALERT_BUTTON_NOT_FOUND")
    XCTAssertEqual(app.staticTexts["agent-device-alert-decline-answer"].label, "Unanswered")
  }
}
#endif
