import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testAlertAcceptTreatsOpenAsAffirmative() {
    XCTAssertTrue(RunnerAlertButtonChoice.isAcceptButton("Open"))
  }

  func testAlertDismissRefusesPlainAffirmativeLabelsOutsideTheOriginalList() {
    // The sole-unclaimed fallback may only ever reach a label `isAcceptButton` does not read as
    // affirmative, so consent copy that plainly reads affirmative must be claimed here too —
    // otherwise dismissing a one-button "Accept" prompt would activate it (#3627).
    for labels in [["Accept"], ["I Agree"], ["Got it"], ["Allow Tracking"], ["Use App"]] {
      XCTAssertNil(
        RunnerAlertButtonChoice.buttonIndex(for: labels, action: "dismiss"),
        "dismiss must fail without a tap rather than consent through \(labels)"
      )
    }
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
    // The list entry alone decides this shape: with only "Ask App Not to Track" claimed as a
    // decline, both labels would otherwise be unclaimed and the choice must refuse.
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: ["Ask App Not to Track", "Learn More"], action: "dismiss"),
      0
    )
  }

  func testAlertDismissKeepsAnUnrecognizedDeclineLabelInsteadOfReachingAnAffirmativeOne() {
    // Copy the accept list cannot claim: it is the sole unclaimed label, the only candidate that
    // could decline, so it wins over the trailing "Allow".
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: ["Keep my activity private", "Allow"], action: "dismiss"),
      0
    )
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: ["More info", "Allow", "OK"], action: "dismiss"),
      0
    )
    XCTAssertEqual(
      RunnerAlertButtonChoice.buttonIndex(for: ["Not this time", "Allow Tracking"], action: "dismiss"),
      0
    )
  }

  func testAlertDismissRefusesAPromptWhoseLabelsNeitherListRecognizes() {
    // A fully localized prompt: iOS localizes the affirmative too, so no label is claimed by
    // either list, no position identifies the decline, and a guess could authorize (#3627).
    XCTAssertNil(
      RunnerAlertButtonChoice.buttonIndex(
        for: ["Demander à l’app de ne pas suivre", "Autoriser le suivi"],
        action: "dismiss"
      ),
      "dismiss must fail without a tap rather than guess through a localized prompt"
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

  /// A known decline label wins ahead of any unclaimed label, and accept takes the label its own
  /// list claims even when a decline is present.
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

  /// accept never activates a listed decline: alone it is no acceptance, and with a choice it
  /// takes only a label its own list claims.
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
  /// The reporter's scenario end to end: `alert dismiss` on the App Tracking Transparency prompt,
  /// whose affirmative button is the last one. The command's own report was `dismissed` either
  /// way, so the canary — which button the app actually answered — is the assertion that matters
  /// (#3627).
  @MainActor
  func testAlertDismissAnswersTheTrackingPromptDeclineAndNeverAuthorizes() throws {
    app.launchArguments = ["--agent-device-alert-decline-choice"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    // Resolution is a pure read; a contended hosted simulator can spend far more than the 10 s
    // command timeout on it, so it runs under the sibling fixtures' resolution allowance.
    let alert = try XCTUnwrap(
      resolveAlert(app: app, deadline: Date().addingTimeInterval(RunnerTests.alertResolutionAllowance))
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
      resolveAlert(app: app, deadline: Date().addingTimeInterval(RunnerTests.alertResolutionAllowance))
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
