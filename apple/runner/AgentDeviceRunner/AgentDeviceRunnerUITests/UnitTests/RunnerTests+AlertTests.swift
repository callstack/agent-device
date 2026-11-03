import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  @MainActor
  func testAlertResolutionDoesNotQueryATerminatedApp() {
    app.terminate()
    XCTAssertEqual(app.state, .notRunning)
    guard case .absent = resolveAlert(app: app, deadline: Date().addingTimeInterval(1)) else {
      return XCTFail("a terminated app must resolve to no alert")
    }
  }

  @MainActor
  func requireResolvedAlert(within timeout: TimeInterval) throws -> RunnerAlert {
    try requireResolvedAlert(deadline: Date().addingTimeInterval(timeout))
  }

  @MainActor
  func requireResolvedAlert(deadline: Date) throws -> RunnerAlert {
    let resolution = resolveAlert(app: app, deadline: deadline)
    guard case .resolved(let alert) = resolution else {
      return try XCTUnwrap(nil as RunnerAlert?, "expected a resolved alert, got \(resolution)")
    }
    return alert
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
    guard case .absent = resolveAlert(
      app: app,
      deadline: startedAt.addingTimeInterval(RunnerTests.defaultAlertCommandTimeout)
    ) else {
      return XCTFail("a screen without an alert must resolve to no alert")
    }
    // Half the command's own budget: an absent alert answers ALERT_NOT_FOUND well inside it on a
    // contended host, while a read per element spends it many times over on this screen.
    XCTAssertLessThan(Date().timeIntervalSince(startedAt), RunnerTests.defaultAlertCommandTimeout / 2)
  }

  @MainActor
  func testAlertResolutionFindsADismissPopupMarkerOnACrowdedScreen() throws {
    launchCrowdedScreen(extraArguments: ["--agent-device-dismiss-popup"])
    defer { terminateCrowdedScreen() }

    let alert = try requireResolvedAlert(within: RunnerTests.defaultAlertCommandTimeout)
    XCTAssertEqual(alert.source, .dismissPopup)
    XCTAssertEqual(alert.root.elementType, .window)
    XCTAssertTrue(alert.actions.contains { $0.identifier == " Dismiss Popup " })
  }

  @MainActor
  func testAlertResolutionFindsAWindowThatIsItselfTheDismissPopupMarker() throws {
    launchCrowdedScreen(extraArguments: ["--agent-device-dismiss-popup-window"])
    defer { terminateCrowdedScreen() }

    let alert = try requireResolvedAlert(within: RunnerTests.defaultAlertCommandTimeout)
    XCTAssertEqual(alert.source, .dismissPopup)
    XCTAssertEqual(alert.root.identifier, "Dismiss popup")
    XCTAssertTrue(alert.actions.contains { $0.identifier == "agent-device-close-popover" })
  }

  /// `alert dismiss` on the marker window must still name its close button: the marker is the
  /// app's own decline declaration, so the choice reaches it even though "Close popover" is on
  /// no list (#3627 left this surface at base behavior).
  @MainActor
  func testAlertDismissOnADismissPopupWindowChoosesThePopoverCloseButton() throws {
    launchCrowdedScreen(extraArguments: ["--agent-device-dismiss-popup-window"])
    defer { terminateCrowdedScreen() }

    let alert = try requireResolvedAlert(within: RunnerTests.defaultAlertCommandTimeout)
    let button = try XCTUnwrap(try chooseAlertButton(alert, action: "dismiss"))
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

    let alert = try requireResolvedAlert(within: RunnerTests.defaultAlertCommandTimeout)
    let inspection = try handleAlert(alert, action: "get", deadline: Date().addingTimeInterval(RunnerTests.defaultAlertCommandTimeout))
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
