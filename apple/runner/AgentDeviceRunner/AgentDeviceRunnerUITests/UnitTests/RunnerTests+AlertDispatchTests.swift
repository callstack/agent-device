import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
extension RunnerTests {
  @MainActor
  func testAlertDispatchResolvesItsOwnModalWithoutCoordinateTapRoutingProbe() throws {
    final class ResultBox {
      var routingProbeCount = 0
      var resolutionCount = 0
    }
    let box = ResultBox()
    mainOwned.app = springboard
    mainOwned.bundleId = Self.springboardBundleId
    systemModalProbeOverrideForTesting = { _ in
      box.routingProbeCount += 1
      return nil
    }
    alertResolutionOverrideForTesting = { _ in
      box.resolutionCount += 1
      return .absent
    }
    defer {
      systemModalProbeOverrideForTesting = nil
      alertResolutionOverrideForTesting = nil
      mainOwned.app = nil
      mainOwned.bundleId = nil
    }
    let command = try runnerCommandFixture(
      #"{"command":"alert","commandId":"alert-routing-once","appBundleId":"com.apple.springboard","action":"get","timeoutMs":1000}"#
    )
    let response = try execute(command: command)
    XCTAssertEqual(response.error?.code, "ALERT_NOT_FOUND")
    XCTAssertEqual(box.resolutionCount, 1)
    XCTAssertEqual(box.routingProbeCount, 0)
  }

  /// A blocking system modal whose host cannot be read is a prompt on screen, not an absent one:
  /// the host retries and reports absence on `ALERT_NOT_FOUND`, so the reply must carry its own code.
  @MainActor
  func testAlertDispatchReportsAnUnresolvedSystemModalAsSeenNotAbsent() throws {
    mainOwned.app = springboard
    mainOwned.bundleId = Self.springboardBundleId
    alertResolutionOverrideForTesting = { _ in .unresolved }
    defer {
      alertResolutionOverrideForTesting = nil
      mainOwned.app = nil
      mainOwned.bundleId = nil
    }
    for action in ["get", "accept", "dismiss"] {
      let command = try runnerCommandFixture(
        #"{"command":"alert","commandId":"alert-unresolved-\#(action)","appBundleId":"com.apple.springboard","action":"\#(action)","timeoutMs":1000}"#
      )
      let response = try execute(command: command)
      XCTAssertFalse(response.ok, action)
      XCTAssertEqual(response.error?.code, RunnerWireErrorCode.alertUnresolved, action)
      XCTAssertEqual(response.error?.hint, RunnerTests.alertUnresolvedHint, action)
    }
  }

  @MainActor
  func testAlertResolutionCannotBypassRequestedDeadline() throws {
    final class ResultBox {
      var observedDeadline: Date?
    }
    let box = ResultBox()
    let releaseResolution = DispatchSemaphore(value: 0)
    let resolutionExited = expectation(description: "bounded alert resolution exited")
    let command = try runnerCommandFixture(
      #"{"command":"alert","commandId":"alert-deadline","appBundleId":"com.apple.springboard","action":"get","timeoutMs":500}"#
    )
    mainOwned.app = springboard
    mainOwned.bundleId = Self.springboardBundleId
    alertResolutionOverrideForTesting = { deadline in
      box.observedDeadline = deadline
      _ = releaseResolution.wait(timeout: .now() + 1)
      resolutionExited.fulfill()
      return .absent
    }
    defer {
      releaseResolution.signal()
      alertResolutionOverrideForTesting = nil
      mainOwned.app = nil
      mainOwned.bundleId = nil
    }

    let commandStartedAt = Date()
    // The resolution outlives the 500 ms request, so only the deadline-bounded dispatch can throw
    // the main-thread timeout; a bypassed deadline answers ALERT_NOT_FOUND once it returns.
    XCTAssertThrowsError(try execute(command: command)) { error in
      let error = error as NSError
      XCTAssertEqual(error.domain, RunnerErrorDomain.general)
      XCTAssertEqual(error.code, RunnerErrorCode.mainThreadExecutionTimedOut)
    }
    let observedDeadline = try XCTUnwrap(box.observedDeadline)
    XCTAssertEqual(observedDeadline.timeIntervalSince(commandStartedAt), 0.5, accuracy: 0.05)

    releaseResolution.signal()
    wait(for: [resolutionExited], timeout: 1)
  }
}
#endif
