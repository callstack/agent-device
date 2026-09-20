import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  func testAlertAcceptDoesNotActivateAReplacementWithASharedButton() throws {
    try assertReplacementAlertUntouched(action: "accept", arguments: [], confirmed: true)
  }

  func testAlertDismissDoesNotActivateAReplacementWithTheSameTitle() throws {
    try assertReplacementAlertUntouched(action: "dismiss", arguments: ["--agent-device-alert-same-title"], confirmed: true)
  }

  func testAlertCannotProveAnIdenticalReplacementAndDoesNotActivateIt() throws {
    try assertReplacementAlertUntouched(
      action: "accept",
      arguments: ["--agent-device-alert-same-title", "--agent-device-alert-same-body"],
      confirmed: false
    )
  }

  func testAlertReplacementCommandDeadlineScalesWithMeasuredLatency() {
    // A quiet host still asks for the production default: 24 reads at 10 ms is a quarter of a second.
    XCTAssertEqual(RunnerTests.alertReplacementCommandTimeoutMs(measuredRoundTrip: 0.001), 10_000)
    XCTAssertEqual(RunnerTests.alertReplacementCommandTimeoutMs(measuredRoundTrip: 0.01), 10_000)
    // The linear region is where a contended host lands: one second per read buys the 24 reads
    // twice over, which is what the red nightly nights needed and 10 s did not cover.
    XCTAssertEqual(RunnerTests.alertReplacementCommandTimeoutMs(measuredRoundTrip: 1), 48_000)
    // Past the cap the fixture gives up rather than dominate the lane, whatever the host costs.
    XCTAssertEqual(RunnerTests.alertReplacementCommandTimeoutMs(measuredRoundTrip: 2.5), 60_000)
    XCTAssertEqual(RunnerTests.alertReplacementCommandTimeoutMs(measuredRoundTrip: 300), 60_000)
    XCTAssertEqual(
      RunnerTests.alertResolutionReadsBeforeActivation,
      24,
      "the decomposition below is the traced command path; re-trace it before changing a count"
    )
  }

  func testAlertDeadlineBeforeActivationLeavesTheOriginalUntouched() throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let alert = try XCTUnwrap(resolveAlert(app: app, deadline: Date().addingTimeInterval(10)))
    let response = handleAlert(alert, action: "accept", deadline: .distantPast)
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "ALERT_DEADLINE_EXCEEDED")
    XCTAssertTrue(app.alerts.firstMatch.exists)
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 0; replacement actions: 0")
  }

  func testAlertHittableProbeCompletingAfterDeadlineLeavesTheOriginalUntouched() throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression"]
    app.launch()
    defer {
      alertButtonHittabilityProbeOverrideForTesting = nil
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let alert = try XCTUnwrap(resolveAlert(app: app, deadline: Date().addingTimeInterval(10)))
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

  func testAlertActivationIgnoresAnAppThatNeverSettlesBeforeTheDeadline() throws {
    app.launchArguments = [
      "--agent-device-alert-replacement-regression",
      "--agent-device-alert-activation-busy"
    ]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let alert = try XCTUnwrap(resolveAlert(app: app, deadline: Date().addingTimeInterval(10)))

    let deadline = Date().addingTimeInterval(6)
    let startedAt = Date()
    let response = handleAlert(alert, action: "accept", deadline: deadline)
    let elapsed = Date().timeIntervalSince(startedAt)

    // The fixture keeps an animation in flight, which is what XCTest waits out before it synthesises
    // an event, so this comes back early only because activation refused to wait for an app that has
    // no intention of settling (#2546).
    XCTAssertLessThan(elapsed, 9, "activation waited \(elapsed)s for a busy app to idle")
    XCTAssertTrue(response.ok, String(describing: response.error))
    let recordedActions = app.staticTexts["agent-device-alert-actions"].label
    if response.ok {
      XCTAssertEqual(recordedActions, "First actions: 1; replacement actions: 0")
    } else {
      XCTAssertEqual(
        recordedActions,
        "First actions: 0; replacement actions: 0",
        "a caller told about an expired deadline must not have a button activated behind it"
      )
    }
  }

  /// The accessibility round trips `resolveAlert` spends before a button is chosen, decomposed from
  /// the implementation rather than counted off one trace: the blocking-modal probe scans
  /// SpringBoard's alert and sheet lists and re-reads the candidate it settles on; the app's own
  /// alert list is resolved and then read for existence and frame; `actionableElements` issues one
  /// fetch per member of `actionableTypes`; and every candidate then pays `exists`, `isHittable`,
  /// `elementType`, `frame`, `label` and `isEnabled` of its own.
  static let alertResolutionModalProbeReads = 3
  static let alertResolutionAlertRootReads = 3
  static let alertResolutionActionableTypeReads = 6
  static let alertResolutionButtonCandidates = 2
  static let alertResolutionCandidateReads = 6

  static let alertResolutionReadsBeforeActivation =
    alertResolutionModalProbeReads + alertResolutionAlertRootReads + alertResolutionActionableTypeReads
    + alertResolutionButtonCandidates * alertResolutionCandidateReads

  /// The reads that follow resolution — the hittability wait and the first verification observation
  /// run on the same channel — plus the allowance for a host that gets slower mid-command.
  private static let alertCommandSafetyFactor: TimeInterval = 2

  /// No higher than the slowest test this lane already runs (61 s on a green nightly), so a badly
  /// starved host cannot make these fixtures the lane's worst contributor. The cap covers the worst
  /// night traced so far, which needed 40.4 s of deadline.
  private static let alertCommandTimeoutCap: TimeInterval = 60

  /// The alert command's deadline for the replacement fixtures.
  ///
  /// `timeoutMs` bounds the whole command, so it is only meaningful in units of what one
  /// accessibility read costs this host right now: `RunnerTests+Alert.swift` starts the deadline at
  /// dispatch and the resolution above spends all of it reading before anything is activated. The
  /// hosted lane runs a read at about 10 ms on a healthy night and about 1.7 s on a red one, which
  /// is why the fixed 10 s these fixtures asked for passed on green nights and expired mid-resolution
  /// on red ones (runs 35, 36 and 37 needed 31.2 s, 30.6 s and 40.4 s). Deriving the budget from a
  /// measured read is `docs/agents/testing.md`'s preferred answer for a timeout that only fails on a
  /// contended host; production still defaults to `defaultAlertCommandTimeout` for real callers.
  static func alertReplacementCommandTimeoutMs(measuredRoundTrip: TimeInterval) -> Int {
    let derived = measuredRoundTrip * Double(alertResolutionReadsBeforeActivation) * alertCommandSafetyFactor
    return Int((min(max(derived, defaultAlertCommandTimeout), alertCommandTimeoutCap) * 1000).rounded())
  }

  /// Samples the read the command is about to pay 24 times, once the alert is up, so the sample comes
  /// from the window the command runs in. Two samples and the slower one wins: a single lucky read
  /// must not size the budget low, and this is a worst-of measurement, not a mean.
  private func measuredAccessibilityRoundTrip() -> TimeInterval {
    let recordedActions = app.staticTexts["agent-device-alert-actions"]
    var roundTrip = TimeInterval(0.001)
    for _ in 0..<2 {
      let startedAt = Date()
      _ = recordedActions.label
      roundTrip = max(roundTrip, Date().timeIntervalSince(startedAt))
    }
    return roundTrip
  }

  private func assertReplacementAlertUntouched(action: String, arguments: [String], confirmed: Bool) throws {
    app.launchArguments = ["--agent-device-alert-replacement-regression"] + arguments
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: appExistenceTimeout))
    let measuredRoundTrip = measuredAccessibilityRoundTrip()
    let timeoutMs = RunnerTests.alertReplacementCommandTimeoutMs(measuredRoundTrip: measuredRoundTrip)
    let command = try runnerCommandFixture(
      #"{"command":"alert","commandId":"alert-replacement","action":"\#(action)","timeoutMs":\#(timeoutMs)}"#
    )
    let response = try executeOnMainPrepared(command: command, activeApp: app)
    let budget = "timeoutMs \(timeoutMs) from a \(String(format: "%.3f", measuredRoundTrip))s read"
    XCTAssertEqual(response.ok, confirmed, "\(budget): \(String(describing: response.error))")
    if !confirmed { XCTAssertEqual(response.error?.code, "ALERT_DEADLINE_EXCEEDED") }
    XCTAssertTrue(app.alerts.firstMatch.exists, "the replacement must remain visible")
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 1; replacement actions: 0")
    let current = try XCTUnwrap(resolveAlert(app: app, deadline: Date().addingTimeInterval(10)))
    let inspection = handleAlert(current, action: "get", deadline: Date().addingTimeInterval(10))
    XCTAssertTrue(inspection.ok)
    XCTAssertEqual(inspection.data?.items?.sorted(), ["Cancel", "OK"])
    XCTAssertEqual(app.staticTexts["agent-device-alert-actions"].label, "First actions: 1; replacement actions: 0")
  }
#endif
}
