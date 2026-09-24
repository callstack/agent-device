import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  @MainActor
  func testAlertAcceptDoesNotActivateAReplacementWithASharedButton() throws {
    try assertReplacementAlertUntouched(action: "accept", arguments: [], confirmed: true)
  }

  @MainActor
  func testAlertDismissDoesNotActivateAReplacementWithTheSameTitle() throws {
    try assertReplacementAlertUntouched(action: "dismiss", arguments: ["--agent-device-alert-same-title"], confirmed: true)
  }

  @MainActor
  func testAlertCannotProveAnIdenticalReplacementAndDoesNotActivateIt() throws {
    try assertReplacementAlertUntouched(
      action: "accept",
      arguments: ["--agent-device-alert-same-title", "--agent-device-alert-same-body"],
      confirmed: false
    )
  }

  @MainActor
  func testAlertDeadlineBeforeActivationLeavesTheOriginalUntouched() throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let alert = try resolveAlertBeforeTheCommand()
    let response = handleAlert(alert, action: "accept", deadline: .distantPast)
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "ALERT_DEADLINE_EXCEEDED")
    XCTAssertTrue(app.alerts.firstMatch.exists)
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 0; replacement actions: 0")
  }

  @MainActor
  func testAlertHittableProbeCompletingAfterDeadlineLeavesTheOriginalUntouched() throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression"]
    app.launch()
    defer {
      alertButtonHittabilityProbeOverrideForTesting = nil
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let alert = try resolveAlertBeforeTheCommand()
    alertButtonHittabilityProbeOverrideForTesting = { probeDeadline in
      while Date() < probeDeadline {
        Thread.sleep(forTimeInterval: min(0.02, max(0, probeDeadline.timeIntervalSinceNow)))
      }
      return true
    }
    let response = handleAlert(alert, action: "accept", deadline: Date().addingTimeInterval(1))
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "ALERT_DEADLINE_EXCEEDED")
    XCTAssertTrue(app.alerts.firstMatch.exists)
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 0; replacement actions: 0")
  }

  @MainActor
  func testAlertActivationAfterDeadlineDoesNotTapTheOriginal() throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let alert = try resolveAlertBeforeTheCommand()
    let button = try XCTUnwrap(alert.buttons.first { $0.label == "OK" })
    let frame = button.frame

    let outcome = activateAlertButton(alert, button: button, action: "accept", frame: frame, deadline: .distantPast)

    XCTAssertNil(outcome, "an expired command must not synthesize a tap")
    XCTAssertNil(activateAlertButton(alert, button: button, action: "accept", frame: .zero, deadline: .distantFuture))
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 0; replacement actions: 0")
  }

  @MainActor
  func testAlertActivationIgnoresAnAppThatNeverSettlesBeforeTheDeadline() throws {
    app.launchArguments = [
      "--agent-device-alert-replacement-regression",
      "--agent-device-alert-activation-busy",
      String(RunnerTests.alertResolutionAllowance + RunnerTests.alertActivationDeadline)
    ]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let alert = try resolveAlertBeforeTheCommand()

    let response = handleAlert(alert, action: "accept", deadline: Date().addingTimeInterval(RunnerTests.alertActivationDeadline))

    // The fixture keeps an animation in flight until a button is answered or its backstop, which
    // outlasts resolution plus activation, stops it, and an in-flight animation is what XCTest waits
    // out before it synthesises an event. An answer that arrives while the app is still busy is one
    // activation did not wait to idle (#2546).
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 1; replacement actions: 0")
    XCTAssertEqual(app.staticTexts["agent-device-alert-busy-answer"].label, "Answered while busy")
  }

  @MainActor
  func testAlertActivationDoesNotWaitOutANotificationBanner() throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression", "--agent-device-alert-banner"]
    app.launch()
    let banner = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      .descendants(matching: .any)["NotificationShortLookView"]
    var consultedInterruptions: [String] = []
    let monitor = addUIInterruptionMonitor(withDescription: "alert activation banner") { element in
      consultedInterruptions.append(element.identifier)
      return false
    }
    defer {
      removeUIInterruptionMonitor(monitor)
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
      _ = banner.waitForNonExistence(timeout: 15)
    }
    acceptNotificationAuthorizationUntilAlertAppears()
    XCTAssertTrue(banner.waitForExistence(timeout: appExistenceTimeout), "the fixture keeps a banner up")
    let alert = try resolveAlertBeforeTheCommand()

    let response = handleAlert(alert, action: "accept", deadline: Date().addingTimeInterval(RunnerTests.alertBannerActivationDeadline))

    XCTAssertEqual(consultedInterruptions, [], "alert activation waited on XCTest's interruption handling")
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 1; replacement actions: 0")
  }

  /// The banner fixture presents its alert only once this app may post notifications; a fresh
  /// simulator asks first, through SpringBoard.
  private func acceptNotificationAuthorizationUntilAlertAppears() {
    let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
    let fixtureAlert = app.alerts.firstMatch
    let deadline = Date().addingTimeInterval(appExistenceTimeout)
    while Date() < deadline, !fixtureAlert.exists {
      if allow.exists {
        allow.tap()
      } else {
        Thread.sleep(forTimeInterval: 0.25)
      }
    }
    XCTAssertTrue(fixtureAlert.exists, "the banner fixture needs notification authorization before it presents its alert")
  }

  /// Resolution reads the alert, its owner and every candidate button before anything is activated,
  /// and a contended hosted simulator has spent 40 s of reads there. These fixtures prove what
  /// activation and verification do, so they resolve first under this allowance, which only a failed
  /// resolution ever spends.
  static let alertResolutionAllowance: TimeInterval = 60

  /// The deadline activation and verification run under once the alert is resolved: a confirmed
  /// answer returns as soon as verification sees the replacement, so only a fixture whose answer is
  /// the deadline itself pays it in full. It buys the dozen reads after resolution 2.5 s each, above the
  /// 1.7 s a read cost on the worst hosted nights traced (#2708).
  static let alertActivationDeadline: TimeInterval = 30
  static let alertBannerActivationDeadline: TimeInterval = 90

  @MainActor
  private func resolveAlertBeforeTheCommand() throws -> RunnerAlert {
    try XCTUnwrap(resolveAlert(app: app, deadline: Date().addingTimeInterval(RunnerTests.alertResolutionAllowance)))
  }

  @MainActor
  private func assertReplacementAlertUntouched(action: String, arguments: [String], confirmed: Bool) throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression"] + arguments
    app.launch()
    defer {
      alertResolutionOverrideForTesting = nil
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let original = try resolveAlertBeforeTheCommand()
    alertResolutionOverrideForTesting = { _ in original }
    let timeoutMs = Int(RunnerTests.alertActivationDeadline * 1000)
    let command = try runnerCommandFixture(
      #"{"command":"alert","commandId":"alert-replacement","action":"\#(action)","timeoutMs":\#(timeoutMs)}"#
    )
    let response = try executeOnMainPrepared(command: command, activeApp: app)
    alertResolutionOverrideForTesting = nil
    XCTAssertEqual(response.ok, confirmed, String(describing: response.error))
    if !confirmed { XCTAssertEqual(response.error?.code, "ALERT_DEADLINE_EXCEEDED") }
    XCTAssertTrue(app.alerts.firstMatch.exists, "the replacement must remain visible")
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 1; replacement actions: 0")
    let current = try resolveAlertBeforeTheCommand()
    let inspection = handleAlert(current, action: "get", deadline: Date().addingTimeInterval(RunnerTests.alertActivationDeadline))
    XCTAssertTrue(inspection.ok)
    XCTAssertEqual(inspection.data?.items?.sorted(), ["Cancel", "OK"])
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 1; replacement actions: 0")
  }
#endif
}
