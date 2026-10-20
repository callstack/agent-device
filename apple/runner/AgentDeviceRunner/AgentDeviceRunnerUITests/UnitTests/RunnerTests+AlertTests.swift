import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  @MainActor
  func testAlertResolutionDoesNotQueryATerminatedApp() {
    app.terminate()
    XCTAssertEqual(app.state, .notRunning)
    XCTAssertNil(resolveAlert(app: app, deadline: Date().addingTimeInterval(1)))
  }
}
#endif
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
extension RunnerTests {
  @MainActor
  func testAlertResolutionWithoutAnAlertDoesNotReadEveryElementOfTheScreen() throws {
    launchCrowdedScreen(extraArguments: [])
    defer { terminateCrowdedScreen() }

    let startedAt = Date()
    XCTAssertNil(resolveAlert(app: app, deadline: startedAt.addingTimeInterval(RunnerTests.defaultAlertCommandTimeout)))
    // Half the command's own budget: an absent alert answers ALERT_NOT_FOUND well inside it on a
    // contended host, while a read per element spends it many times over on this screen.
    XCTAssertLessThan(Date().timeIntervalSince(startedAt), RunnerTests.defaultAlertCommandTimeout / 2)
  }

  @MainActor
  func testAlertResolutionFindsADismissPopupMarkerOnACrowdedScreen() throws {
    launchCrowdedScreen(extraArguments: ["--agent-device-dismiss-popup"])
    defer { terminateCrowdedScreen() }

    let alert = try XCTUnwrap(
      resolveAlert(app: app, deadline: Date().addingTimeInterval(RunnerTests.defaultAlertCommandTimeout))
    )
    XCTAssertEqual(alert.source, .dismissPopup)
    XCTAssertEqual(alert.root.elementType, .window)
    XCTAssertTrue(alert.buttons.contains { $0.identifier == " Dismiss Popup " })
  }

  @MainActor
  func testAlertResolutionFindsAWindowThatIsItselfTheDismissPopupMarker() throws {
    launchCrowdedScreen(extraArguments: ["--agent-device-dismiss-popup-window"])
    defer { terminateCrowdedScreen() }

    let alert = try XCTUnwrap(
      resolveAlert(app: app, deadline: Date().addingTimeInterval(RunnerTests.defaultAlertCommandTimeout))
    )
    XCTAssertEqual(alert.source, .dismissPopup)
    XCTAssertEqual(alert.root.identifier, "Dismiss popup")
    XCTAssertTrue(alert.buttons.contains { $0.identifier == "agent-device-close-popover" })
  }

  /// `alert dismiss` on the marker window must still name its close button: the marker is the
  /// app's own decline declaration, so the choice reaches it even though "Close popover" is on
  /// no list (#3627 left this surface at base behavior).
  @MainActor
  func testAlertDismissOnADismissPopupWindowChoosesThePopoverCloseButton() throws {
    launchCrowdedScreen(extraArguments: ["--agent-device-dismiss-popup-window"])
    defer { terminateCrowdedScreen() }

    let alert = try XCTUnwrap(
      resolveAlert(app: app, deadline: Date().addingTimeInterval(RunnerTests.defaultAlertCommandTimeout))
    )
    let button = try XCTUnwrap(chooseAlertButton(alert, action: "dismiss"))
    XCTAssertEqual(button.identifier, "agent-device-close-popover")
  }

  @MainActor
  func testAlertTitleIsTheAlertsOwnTextNotLabelledChromeInsideTheRoot() throws {
    // The resolution root of an older-iOS confirmation carries host chrome whose accessibility
    // label is not copy (the Home Screen page readout). The title is the alert's own static text.
    app.launchArguments = [
      "--agent-device-dismiss-popup-window",
      "--agent-device-alert-title-page-chrome",
    ]
    app.launch()
    defer { terminateCrowdedScreen() }

    let alert = try XCTUnwrap(
      resolveAlert(app: app, deadline: Date().addingTimeInterval(RunnerTests.defaultAlertCommandTimeout))
    )
    let inspection = handleAlert(alert, action: "get", deadline: Date().addingTimeInterval(RunnerTests.defaultAlertCommandTimeout))
    XCTAssertTrue(inspection.ok)
    XCTAssertEqual(inspection.data?.message, "Relaunch to continue")
  }

  private func launchCrowdedScreen(extraArguments: [String]) {
    app.launchArguments = ["--agent-device-crowded-screen"] + extraArguments
    app.launch()
    XCTAssertTrue(app.staticTexts["agent-device-crowded-row-499"].waitForFixtureExistence(timeout: appExistenceTimeout))
  }

  @MainActor
  private func terminateCrowdedScreen() {
    invalidateCachedTarget(reason: "unit_test_cleanup")
    app.terminate()
  }
}
#endif
