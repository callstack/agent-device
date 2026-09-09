import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  func testTextInputProbePreservesEnclosingRunnerWait() {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    defer {
      textInputProbeIssueForTesting = nil
      app.terminate()
    }
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForExistence(timeout: appExistenceTimeout))
    let point = CGPoint(x: field.frame.midX, y: field.frame.midY)
    let completed = expectation(description: "optional probe completed inside runner wait")
    DispatchQueue.main.async {
      self.textInputProbeIssueForTesting = XCTIssue(type: .assertionFailure, compactDescription: "Optional probe issue during runner wait")
      _ = self.probeTextInputs(app: self.app, point: point)
      completed.fulfill()
    }
    guard XCTWaiter.wait(for: [completed], timeout: 5) == .completed else {
      return XCTFail("Optional probe interrupted the runner wait")
    }
    XCTAssertNil(textInputProbeIssues)
    NSLog("AGENT_DEVICE_RUNNER_OPTIONAL_PROBE_WAIT_COMPLETED")
  }

  func testTextInputProbeIssueScopeIsThreadBound() {
    let issue = XCTIssue(type: .assertionFailure, compactDescription: "Issue scope thread check")
    XCTAssertFalse(containTextInputProbeIssue(issue))
    let scope = TextInputProbeIssues()
    suppressedIssueLock.lock()
    textInputProbeIssues = scope
    suppressedIssueLock.unlock()
    defer {
      suppressedIssueLock.lock()
      textInputProbeIssues = nil
      suppressedIssueLock.unlock()
    }
    let finished = DispatchSemaphore(value: 0)
    let result = ProbeThreadResult()
    Thread.detachNewThread {
      result.contained = self.containTextInputProbeIssue(issue)
      finished.signal()
    }
    guard finished.wait(timeout: .now() + 2) == .success else {
      return XCTFail("Background issue classification did not finish")
    }
    XCTAssertFalse(result.contained)
    XCTAssertEqual(scope.count, 0)
    XCTAssertTrue(containTextInputProbeIssue(issue))
    XCTAssertEqual(scope.count, 1)
  }

  func testHealthyCoordinateTapPreservesBareTypingWitness() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForExistence(timeout: appExistenceTimeout))
    let frame = field.frame
    currentApp = app
    currentBundleId = "com.callstack.agentdevice.runner"
    currentAppProcessIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))
    clearSnapshotXCTestChannelPenalty(reason: "fresh-runner")
    let failures = currentXCTestFailureCount()
    let tap = try runnerCommandFixture(
      #"{"appBundleId":"com.callstack.agentdevice.runner","command":"tap","commandId":"tap-healthy-probe","x":\#(frame.midX),"y":\#(frame.midY),"synthesized":true}"#
    )
    let tapped = try execute(command: tap)
    XCTAssertTrue(tapped.ok, String(describing: tapped.error))
    XCTAssertNotNil(textEntryTapWitness)
    XCTAssertFalse(isSnapshotXCTestChannelPenalized(bundleId: currentBundleId))
    try XCTSkipIf(isKeyboardVisible(app: app), "software keyboard is up; hidden-keyboard witness cannot be exercised")
    let type = try runnerCommandFixture(#"{"appBundleId":"com.callstack.agentdevice.runner","command":"type","commandId":"type-healthy-probe","text":"probe-witness"}"#)
    let typed = try execute(command: type)
    XCTAssertTrue(typed.ok, String(describing: typed.error))
    XCTAssertEqual(typed.data?.textEntryRoute, "synthesized-first-responder")
    XCTAssertEqual(field.value as? String, "probe-witness")
    XCTAssertFalse(didRecordXCTestFailure(since: failures))
  }

  func testTextInputProbeContainmentExcludesRequiredReadsAndLaterIssues() {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    defer {
      textInputProbeIssueForTesting = nil
      app.terminate()
    }
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForExistence(timeout: appExistenceTimeout))
    let point = CGPoint(x: field.frame.midX, y: field.frame.midY)
    let expected = XCTIssue(type: .assertionFailure, compactDescription: "Required query failure must escape optional containment")
    let options = XCTExpectedFailure.Options()
    var observed = 0
    options.issueMatcher = { issue in
      guard issue.type == expected.type, issue.compactDescription == expected.compactDescription else { return false }
      observed += 1
      return true
    }
    XCTExpectFailure("Required read and later issue belong to their caller", options: options) {
      textInputProbeIssueForTesting = expected
      _ = textInputAt(app: app, x: point.x, y: point.y)
      _ = probeTextInputs(app: app, point: point)
      record(expected)
    }
    XCTAssertEqual(observed, 2)
  }

  func testSuppressedAxIssueMakesTextInputProbeUnavailable() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    defer {
      textInputProbeIssueForTesting = nil
      app.terminate()
    }
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForExistence(timeout: appExistenceTimeout))
    let frame = field.frame
    textInputProbeIssueForTesting = XCTIssue(type: .assertionFailure, compactDescription: "Failed to get matching snapshot: kAXErrorIllegalArgument")
    let outcome = probeTextInputs(app: app, point: CGPoint(x: frame.midX, y: frame.midY))
    guard case .unavailable = outcome else {
      return XCTFail("A suppressed AX issue must discard the matching candidate")
    }
  }

  func testFreshCoordinateTapContainsUnavailableTextInputProbe() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    defer {
      textInputProbeIssueForTesting = nil
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let target = app.staticTexts["Agent Device Runner"]
    XCTAssertTrue(target.waitForExistence(timeout: appExistenceTimeout))
    let frame = target.frame
    currentApp = app
    currentBundleId = "com.callstack.agentdevice.runner"
    currentAppProcessIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))
    clearSnapshotXCTestChannelPenalty(reason: "fresh-runner")
    let failures = currentXCTestFailureCount()
    textInputProbeIssueForTesting = XCTIssue(type: .assertionFailure, compactDescription: "Injected optional text input query failure")
    let command = try runnerCommandFixture(
      #"{"appBundleId":"com.callstack.agentdevice.runner","command":"tap","commandId":"tap-probe-unavailable","x":\#(frame.midX),"y":\#(frame.midY),"synthesized":true}"#
    )
    let response = try execute(command: command)
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertFalse(didRecordXCTestFailure(since: failures))
    XCTAssertFalse(isSnapshotXCTestChannelPenalized(bundleId: currentBundleId))
    XCTAssertNil(textEntryTapWitness)
    let type = try runnerCommandFixture(#"{"appBundleId":"com.callstack.agentdevice.runner","command":"type","commandId":"type-after-unavailable-probe","text":"must-not-type"}"#)
    let typed = try execute(command: type)
    XCTAssertFalse(typed.ok)
    XCTAssertEqual(typed.error?.code, "TEXT_INPUT_NOT_FOCUSED")
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    let fieldFrame = field.frame
    let nextTap = try runnerCommandFixture(
      #"{"appBundleId":"com.callstack.agentdevice.runner","command":"tap","commandId":"tap-after-probe-recovery","x":\#(fieldFrame.midX),"y":\#(fieldFrame.midY),"synthesized":true}"#
    )
    XCTAssertTrue(try execute(command: nextTap).ok)
    XCTAssertNotNil(textEntryTapWitness)
    XCTAssertTrue(try execute(command: type).ok)
    XCTAssertEqual(field.value as? String, "must-not-type")
  }
#endif
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
private final class ProbeThreadResult: @unchecked Sendable {
  var contained = false
}
#endif
