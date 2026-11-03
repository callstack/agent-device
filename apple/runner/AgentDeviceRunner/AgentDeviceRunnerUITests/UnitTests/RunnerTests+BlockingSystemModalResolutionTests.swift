import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testRemoteHostProbeRunsOnlyWhenSpringboardModalHasNoActions() {
    XCTAssertTrue(RemoteHostedSystemModalPolicy.shouldProbeRemoteHost(springboardActionCount: 0))
    XCTAssertFalse(RemoteHostedSystemModalPolicy.shouldProbeRemoteHost(springboardActionCount: 1))
    XCTAssertFalse(RemoteHostedSystemModalPolicy.shouldProbeRemoteHost(springboardActionCount: 3))
  }

  func testRemoteHostStateGateFailsClosedToForeground() {
    XCTAssertTrue(RemoteHostedSystemModalPolicy.isEligibleHostState(.runningForeground))
    XCTAssertFalse(RemoteHostedSystemModalPolicy.isEligibleHostState(.runningBackground))
    XCTAssertFalse(RemoteHostedSystemModalPolicy.isEligibleHostState(.notRunning))
    XCTAssertFalse(RemoteHostedSystemModalPolicy.isEligibleHostState(.unknown))
  }

  func testRequiredModalReadPreservesSuccessfulEmptyAndOptionalValues() throws {
    let elements: [XCUIElement] = try readModalValue(deadline: .distantFuture) { [] }
    XCTAssertTrue(elements.isEmpty)
    let element: XCUIElement? = try readModalValue(deadline: .distantFuture) { nil as XCUIElement? }
    XCTAssertNil(element)
    let visible = try readModalValue(deadline: .distantFuture) { false }
    XCTAssertFalse(visible)
    XCTAssertNoThrow(try readModalValue(deadline: .distantFuture) { () })
  }

#if os(iOS)
  @MainActor
  func testAlertRequiredQueryFailureNeverReportsAbsence() throws {
    modalElementsQueryOverrideForTesting = {
      NSException(name: .internalInconsistencyException, reason: "injected required query failure", userInfo: nil).raise()
      return []
    }
    defer { modalElementsQueryOverrideForTesting = nil }
    XCTAssertThrowsError(try firstBlockingSystemModal(in: springboard)) { error in
      guard case ModalReadFailure.queryFailed = error else { return XCTFail("unexpected error: \(error)") }
    }
    for action in ["get", "accept", "wait"] {
      let command = try runnerCommandFixture(
        #"{"command":"alert","commandId":"required-query-\#(action)","action":"\#(action)"}"#
      )
      let response = try executeOnMainPrepared(command: command, activeApp: app)
      XCTAssertEqual(response.error?.code, RunnerWireErrorCode.alertUnresolved, action)
    }
  }

  @MainActor
  func testAlertSpentSearchDeadlineNeverReportsAbsence() throws {
    let deadline = Date.distantPast
    XCTAssertThrowsError(try firstBlockingSystemModal(in: springboard, deadline: deadline)) { error in
      guard case ModalReadFailure.deadlineExceeded = error else { return XCTFail("unexpected error: \(error)") }
    }
    for action in ["get", "accept", "wait"] {
      let command = try runnerCommandFixture(
        #"{"command":"alert","commandId":"spent-search-\#(action)","action":"\#(action)"}"#
      )
      let response = try executeOnMainPrepared(command: command, activeApp: app, alertDeadline: deadline)
      XCTAssertEqual(response.error?.code, RunnerWireErrorCode.alertUnresolved, action)
    }
  }

  @MainActor
  func testAlertSearchFinishingAfterDeadlineNeverReportsAbsence() {
    modalElementsQueryOverrideForTesting = {
      Thread.sleep(forTimeInterval: 0.02)
      return []
    }
    defer { modalElementsQueryOverrideForTesting = nil }
    guard case .unresolved = resolveBlockingSystemModal(deadline: Date().addingTimeInterval(0.01)) else {
      return XCTFail("an empty query that finished too late cannot establish absence")
    }
  }

  @MainActor
  func testAlertSuccessfulEmptySearchIsAbsent() {
    modalElementsQueryOverrideForTesting = { [] }
    defer { modalElementsQueryOverrideForTesting = nil }
    guard case .absent = resolveBlockingSystemModal(deadline: .distantFuture) else {
      return XCTFail("a completed empty search establishes absence")
    }
  }

  @MainActor
  func testAlertRequiredActionsQueryFailureThrows() {
    modalElementsQueryOverrideForTesting = {
      NSException(name: .internalInconsistencyException, reason: "injected actions query failure", userInfo: nil).raise()
      return []
    }
    defer { modalElementsQueryOverrideForTesting = nil }
    XCTAssertThrowsError(try readModalActions(in: app, deadline: .distantFuture)) { error in
      guard case ModalReadFailure.queryFailed = error else { return XCTFail("unexpected error: \(error)") }
    }
  }

  @MainActor
  func testAlertWithNoEnabledButtonsStaysResolved() throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression", "--agent-device-alert-disabled-buttons"]
    app.launch()
    defer { app.terminate() }
    let root = app.alerts.firstMatch
    XCTAssertTrue(root.waitForFixtureExistence(timeout: appExistenceTimeout))
    let buttons = root.buttons.allElementsBoundByIndex
    XCTAssertEqual(buttons.count, 2)
    XCTAssertTrue(buttons.allSatisfy { !$0.isEnabled })
    guard case .resolved(let alert) = resolveAlert(
      app: app, deadline: Date().addingTimeInterval(Self.defaultAlertCommandTimeout)
    ) else { return XCTFail("a recognized surface remains resolved without enabled buttons") }
    XCTAssertEqual(alert.source, .appAlert)
    XCTAssertTrue(alert.buttons.isEmpty)
    let inspection = handleAlert(alert, action: "get", deadline: .distantFuture)
    XCTAssertTrue(inspection.ok)
    XCTAssertEqual(inspection.data?.message, "First confirmation")
    XCTAssertEqual(inspection.data?.items, ["Cancel", "OK"])
    for action in ["accept", "dismiss"] {
      let response = handleAlert(alert, action: action, deadline: .distantFuture)
      XCTAssertEqual(response.error?.code, RunnerWireErrorCode.alertButtonNotFound, action)
    }
  }
#endif

  // No SpringBoard host (`hasSpringBoardSystemModalHost`) means modal resolution must return
  // `.absent` without probing com.apple.springboard (#1351). Written for tvOS, where no lane
  // ever executed it; `resolveBlockingSystemModal` takes that decision at RUNTIME off the same
  // flag on macOS, so the host lane runs the real branch on every PR.
  //
  // Its former sibling `testBlockingSystemAlertSnapshotIsNilOnTvOS` is deleted rather than
  // widened: `blockingSystemAlertSnapshot` is `#if os(macOS) return nil`, so on the only lane
  // that could run it the assertion would pin a compile-time literal — a green that no change
  // to the runner could turn red. The runtime gate it meant to cover is this test's subject,
  // and the nil it returns on macOS is the compiler's business, not a test's.
  #if os(tvOS) || os(macOS)
  func testResolveBlockingSystemModalIsAbsentWithoutSpringBoardHost() {
    guard case .absent = resolveBlockingSystemModal(deadline: .distantFuture) else {
      XCTFail("blocking system-modal resolution must be .absent without a SpringBoard host")
      return
    }
  }
  #endif
}
#endif
