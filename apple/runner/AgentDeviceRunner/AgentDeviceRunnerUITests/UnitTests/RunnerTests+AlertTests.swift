import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testAlertAcceptTreatsOpenAsAffirmative() {
    XCTAssertTrue(isAcceptButton("Open"))
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

  private func launchCrowdedScreen(extraArguments: [String]) {
    app.launchArguments = ["--agent-device-crowded-screen"] + extraArguments
    app.launch()
    XCTAssertTrue(app.staticTexts["agent-device-crowded-row-499"].waitForExistence(timeout: appExistenceTimeout))
  }

  @MainActor
  private func terminateCrowdedScreen() {
    invalidateCachedTarget(reason: "unit_test_cleanup")
    app.terminate()
  }
}
#endif
