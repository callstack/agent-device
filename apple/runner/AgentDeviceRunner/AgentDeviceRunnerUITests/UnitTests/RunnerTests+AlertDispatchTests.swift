import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
extension RunnerTests {
  func testAlertDispatchResolvesItsOwnModalWithoutCoordinateTapRoutingProbe() throws {
    final class ResultBox {
      var routingProbeCount = 0
      var resolutionCount = 0
      var response: Response?
      var error: Error?
    }
    let box = ResultBox()
    let finished = expectation(description: "alert dispatch finished")
    currentApp = springboard
    currentBundleId = Self.springboardBundleId
    systemModalProbeOverrideForTesting = { _ in
      box.routingProbeCount += 1
      return nil
    }
    alertResolutionOverrideForTesting = { _ in
      box.resolutionCount += 1
      return nil
    }
    defer {
      systemModalProbeOverrideForTesting = nil
      alertResolutionOverrideForTesting = nil
      currentApp = nil
      currentBundleId = nil
    }
    let command = try runnerCommandFixture(
      #"{"command":"alert","commandId":"alert-routing-once","appBundleId":"com.apple.springboard","action":"get","timeoutMs":1000}"#
    )
    DispatchQueue(label: "agent-device.runner.tests.alert-routing").async {
      do {
        box.response = try self.execute(command: command)
      } catch {
        box.error = error
      }
      finished.fulfill()
    }
    wait(for: [finished], timeout: 2)
    XCTAssertNil(box.error)
    XCTAssertEqual(box.response?.error?.code, "ALERT_NOT_FOUND")
    XCTAssertEqual(box.resolutionCount, 1)
    XCTAssertEqual(box.routingProbeCount, 0)
  }

  func testAlertResolutionCannotBypassRequestedDeadline() throws {
    final class ResultBox {
      var error: Error?
      var observedDeadline: Date?
      var commandStartedAt: Date?
    }
    let box = ResultBox()
    let releaseResolution = DispatchSemaphore(value: 0)
    let resolutionExited = expectation(description: "bounded alert resolution exited")
    let commandFinished = expectation(description: "alert command respected its deadline")
    let command = try runnerCommandFixture(
      #"{"command":"alert","commandId":"alert-deadline","appBundleId":"com.apple.springboard","action":"get","timeoutMs":500}"#
    )
    currentApp = springboard
    currentBundleId = Self.springboardBundleId
    alertResolutionOverrideForTesting = { deadline in
      box.observedDeadline = deadline
      _ = releaseResolution.wait(timeout: .now() + 1)
      resolutionExited.fulfill()
      return nil
    }
    defer {
      releaseResolution.signal()
      alertResolutionOverrideForTesting = nil
      currentApp = nil
      currentBundleId = nil
    }

    DispatchQueue(label: "agent-device.runner.tests.alert-deadline").async {
      box.commandStartedAt = Date()
      do {
        _ = try self.execute(command: command)
      } catch {
        box.error = error
      }
      commandFinished.fulfill()
    }

    wait(for: [commandFinished], timeout: 1)
    let error = box.error as NSError?
    XCTAssertEqual(error?.domain, RunnerErrorDomain.general)
    XCTAssertEqual(error?.code, RunnerErrorCode.mainThreadExecutionTimedOut)
    XCTAssertNotNil(box.observedDeadline)
    if let observedDeadline = box.observedDeadline,
      let commandStartedAt = box.commandStartedAt
    {
      XCTAssertEqual(observedDeadline.timeIntervalSince(commandStartedAt), 0.5, accuracy: 0.05)
    }

    releaseResolution.signal()
    wait(for: [resolutionExited], timeout: 1)
  }
}
#endif
