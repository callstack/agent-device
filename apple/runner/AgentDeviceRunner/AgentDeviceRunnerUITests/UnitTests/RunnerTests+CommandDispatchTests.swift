import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testInjectedTapRecordedFailureGateIsTapOnlyAndCountGated() {
    // The seam's recording side cannot run in-bundle (a real XCTIssue would
    // fail this very test run — same constraint the record(_:) suppression
    // tests document); the live daemon proof covers it. This pins the gate.
    XCTAssertFalse(RunnerTests.shouldInjectTapRecordedFailure(command: .tap, remaining: 0))
    XCTAssertTrue(RunnerTests.shouldInjectTapRecordedFailure(command: .tap, remaining: 1))
    XCTAssertFalse(RunnerTests.shouldInjectTapRecordedFailure(command: .type, remaining: 1))
    XCTAssertFalse(RunnerTests.shouldInjectTapRecordedFailure(command: .snapshot, remaining: 1))
  }

  func testXCTestRecordedFailureResponseFailsMutatingSuccesses() throws {
    let command = try runnerCommandFixture(#"{"command":"tap","commandId":"tap-1"}"#)
    let response = Response(ok: true, data: DataPayload(message: "tapped"))

    let failureResponse = xctestRecordedFailureResponse(command: command, response: response)

    XCTAssertEqual(failureResponse?.ok, false)
    XCTAssertEqual(failureResponse?.error?.code, "XCTEST_RECORDED_FAILURE")
    XCTAssertEqual(
      failureResponse?.error?.message,
      "XCTest recorded a failure while executing tap; the action may not have been performed."
    )
  }

  func testXCTestRecordedFailureResponseFailsActionButtonSuccess() throws {
    // The Action Button press carries no settle and no post-action observation, so this conversion is
    // the only evidence the press landed. That is why the press is not classified runner-lifecycle:
    // `isLifecycle` would silence the conversion here (#2699, #2702 review).
    let command = try runnerCommandFixture(#"{"command":"actionButton","commandId":"action-button-1"}"#)
    let response = Response(ok: true, data: DataPayload(message: "actionButton"))

    let failureResponse = xctestRecordedFailureResponse(command: command, response: response)

    XCTAssertEqual(failureResponse?.ok, false)
    XCTAssertEqual(failureResponse?.error?.code, "XCTEST_RECORDED_FAILURE")
    XCTAssertEqual(
      failureResponse?.error?.message,
      "XCTest recorded a failure while executing actionButton; the action may not have been performed."
    )
  }

  func testXCTestRecordedFailureResponseDoesNotWrapReadOnlyOrRunnerFatalResponses() throws {
    let snapshotCommand = try runnerCommandFixture(#"{"command":"snapshot","commandId":"snapshot-1"}"#)
    let tapCommand = try runnerCommandFixture(#"{"command":"tap","commandId":"tap-1"}"#)
    let runnerFatalResponse = Response(
      ok: true,
      data: DataPayload(runnerFatal: true, runnerFatalReason: "ax_snapshot_unavailable")
    )

    XCTAssertNil(
      xctestRecordedFailureResponse(
        command: snapshotCommand,
        response: Response(ok: true, data: DataPayload(nodes: [], truncated: false))
      )
    )
    XCTAssertNil(xctestRecordedFailureResponse(command: tapCommand, response: runnerFatalResponse))
  }

  // Simulator-only from here to the matching #endif: these launch the host app, route through
  // SpringBoard, or assert the iOS-only alert/system-modal branches. Tests outside the
  // `os(iOS)` regions in this file are pure runner decisions and also run on the macOS host
  // lane (ci.yml) — see the classification convention in RunnerTests.swift.
#if os(iOS)
  func testMissingBundleCommandInvalidatesCompleteCachedTargetState() throws {
    app.launch()
    currentApp = app
    currentBundleId = "com.example.stale-target"
    currentAppProcessIdentifier = 42
    snapshotXCTestPenaltyWarmupExemption.isPending = true
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let command = try runnerCommandFixture(
      #"{"command":"snapshot","commandId":"snapshot-without-bundle"}"#
    )

    _ = prepareActiveCommandContext(command: command)

    XCTAssertNil(currentApp)
    XCTAssertNil(currentBundleId)
    XCTAssertNil(currentAppProcessIdentifier)
    XCTAssertFalse(snapshotXCTestPenaltyWarmupExemption.isPending)
  }

  func testSkipAppActivationPreflightIncludesForegroundCachedCoordinateOnlyTaps() throws {
    app.launch()
    currentApp = app
    currentBundleId = nil
    defer {
      currentApp = nil
      currentBundleId = nil
      app.terminate()
    }
    let tap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-1","x":10,"y":20}"#
    )

    XCTAssertTrue(shouldSkipAppActivationPreflight(tap))
  }

  func testSkipAppActivationPreflightRejectsMissingChangedAndBackgroundTargets() throws {
    let coordinateTap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-1","x":10,"y":20}"#
    )
    currentApp = nil
    currentBundleId = nil
    XCTAssertFalse(shouldSkipAppActivationPreflight(coordinateTap))

    app.launch()
    currentApp = app
    currentBundleId = "com.example.current"
    defer {
      currentApp = nil
      currentBundleId = nil
      app.terminate()
    }
    let changedBundleTap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-2","appBundleId":"com.example.other","x":10,"y":20}"#
    )

    XCTAssertFalse(shouldSkipAppActivationPreflight(changedBundleTap))

    app.terminate()
    currentApp = app
    currentBundleId = nil

    XCTAssertFalse(shouldSkipAppActivationPreflight(coordinateTap))
  }

  func testActionButtonPressSkipsAppActivationPreflightWithoutBeingRunnerLifecycle() throws {
    currentApp = nil
    currentBundleId = nil
    let press = try runnerCommandFixture(#"{"command":"actionButton","commandId":"action-button-1"}"#)

    // The skip is its own decision, reached without the lifecycle flag that would also drop the
    // recorded-failure conversion; no cached target and no foreground app is required for it.
    XCTAssertFalse(isRunnerLifecycleCommand(.actionButton))
    XCTAssertTrue(shouldSkipAppActivationPreflight(press))
  }

  func testPrepareActiveCommandContextRoutesBlockingSystemModalToSpringboard() throws {
    blockingSystemModalPresenceOverrideForTesting = true
    currentApp = nil
    currentBundleId = nil
    defer {
      blockingSystemModalPresenceOverrideForTesting = nil
      currentApp = nil
      currentBundleId = nil
    }
    let tap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-1","x":10,"y":20}"#
    )

    let preparation = prepareActiveCommandContext(
      command: tap,
      routeToSpringboard: shouldRouteToSpringboardBlockingSystemModal(tap)
    )

    guard case .context(let context) = preparation else {
      XCTFail("expected command context")
      return
    }
    XCTAssertTrue(context.app === springboard)
  }

  func testExecuteDispatchedReturnsBusyBeforeBlockingSystemModalProbeDrains() throws {
    app.launch()
    currentApp = app
    currentBundleId = nil
    defer {
      currentApp = nil
      currentBundleId = nil
      systemModalProbeOverrideForTesting = nil
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      app.terminate()
    }

    final class ResultBox {
      var response: Response?
      var error: Error?
      var commandRecoveredBeforeRelease = false
      var wasBusyBeforeRelease = false
      var hadAbandonedProbeBeforeRelease = false
      var drained = false
    }
    let box = ResultBox()
    let probeStarted = expectation(description: "system-modal routing probe started")
    let verificationFinished = expectation(description: "command recovery and modal probe drain verified")
    let probeReleaseGate = DispatchSemaphore(value: 0)
    let commandFinishedGate = DispatchSemaphore(value: 0)
    systemModalProbeOverrideForTesting = { _ in
      probeStarted.fulfill()
      _ = probeReleaseGate.wait(timeout: .now() + 15)
      return DataPayload(message: "late system modal")
    }

    let command = try runnerCommandFixture(
      #"{"command":"tap","commandId":"bounded-modal-routing","x":10,"y":20}"#
    )
    DispatchQueue(label: "agent-device.runner.tests.modal-routing-probe").async {
      do {
        box.response = try self.executeDispatched(command: command)
      } catch {
        box.error = error
      }
      commandFinishedGate.signal()
    }
    DispatchQueue(label: "agent-device.runner.tests.modal-routing-probe-verifier").async {
      let commandWait = commandFinishedGate.wait(
        timeout: .now() + self.systemModalProbeBudget + 3
      )
      box.commandRecoveredBeforeRelease = commandWait == .success
        && box.error == nil
        && box.response?.error?.code == "RUNNER_BUSY"
      if case .busy = self.currentMainThreadBusyState() {
        box.wasBusyBeforeRelease = true
      }
      box.hadAbandonedProbeBeforeRelease = self.hasAbandonedMainThreadWork()

      // The XCTest main thread is blocked inside the injected probe, so this verifier owns the
      // ordered release after recording the command result and abandoned-work state above.
      probeReleaseGate.signal()
      let deadline = Date().addingTimeInterval(5)
      while self.hasAbandonedMainThreadWork(), Date() < deadline {
        self.sleepFor(0.002)
      }
      box.drained = !self.hasAbandonedMainThreadWork()
      verificationFinished.fulfill()
    }

    wait(for: [probeStarted, verificationFinished], timeout: 15)
    XCTAssertTrue(
      box.commandRecoveredBeforeRelease,
      "the public coordinate tap must return RUNNER_BUSY before the blocked modal probe drains"
    )
    XCTAssertTrue(box.wasBusyBeforeRelease)
    XCTAssertTrue(box.hadAbandonedProbeBeforeRelease)
    XCTAssertTrue(box.drained)
    guard case .idle = currentMainThreadBusyState() else {
      return XCTFail("expected the runner to become idle after the routing probe drained")
    }
    XCTAssertFalse(hasAbandonedMainThreadWork())
  }

  /// A coordinate tap resolves its system-modal routing on the command queue while main may still be
  /// clearing or rebinding the cached target. Target identity belongs to main, so an abandoned
  /// routing probe must arm its penalty with the identity main settled on — never with the identity
  /// the command queue read while that write was still pending (#2781).
  func testCoordinateTapRoutingPenalizesTheIdentityMainSettledOnWhileTheWriteWasPending() throws {
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    let pendingBundleId = "com.example.routing-pending-stale"
    let settledBundleId = "com.example.routing-pending-settled"
    currentApp = app
    currentBundleId = pendingBundleId
    snapshotXCTestPenaltyWarmupExemption.isPending = false
    clearSnapshotXCTestChannelPenalty(reason: "test-setup")
    defer {
      systemModalProbeOverrideForTesting = nil
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }

    // Occupy main and rebind the target inside that block: every identity read that arrives while it
    // is queued sees a target that main is on its way to replacing.
    let mainRelease = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      _ = mainRelease.wait(timeout: .now() + 0.5)
      self.currentBundleId = settledBundleId
    }

    let probeStarted = expectation(description: "system-modal routing probe started")
    let probeReleaseGate = DispatchSemaphore(value: 0)
    systemModalProbeOverrideForTesting = { _ in
      probeStarted.fulfill()
      // Outlives the probe's own slice, so the abandonment hook is what arms the penalty.
      _ = probeReleaseGate.wait(timeout: .now() + 15)
      return nil
    }
    let tap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-pending-target-write","x":10,"y":20}"#
    )

    final class ResultBox {
      var response: Response?
      var penalizedPendingIdentity = false
      var penalizedSettledIdentity = false
    }
    let box = ResultBox()
    let tapFinished = expectation(description: "off-main tap returned")
    DispatchQueue(label: "agent-device.runner.tests.tap-pending-target-write").async {
      box.response = try? self.executeDispatched(command: tap)
      box.penalizedPendingIdentity = self.isSnapshotXCTestChannelPenalized(bundleId: pendingBundleId)
      box.penalizedSettledIdentity = self.isSnapshotXCTestChannelPenalized(bundleId: settledBundleId)
      probeReleaseGate.signal()
      tapFinished.fulfill()
    }

    wait(for: [probeStarted, tapFinished], timeout: 40)
    mainRelease.signal()
    let drainDeadline = Date().addingTimeInterval(5)
    while hasAbandonedMainThreadWork(), Date() < drainDeadline {
      sleepFor(0.002)
    }

    XCTAssertTrue(
      box.penalizedSettledIdentity,
      "the abandoned routing probe must penalize the target main settled on"
    )
    XCTAssertFalse(
      box.penalizedPendingIdentity,
      "the command queue may not key a penalty with an identity whose write was still pending on main"
    )
    XCTAssertFalse(hasAbandonedMainThreadWork())
  }

  func testSkipAppActivationPreflightRejectsSelectorAndMixedSequenceGestures() throws {
    app.launch()
    currentApp = app
    currentBundleId = nil
    defer {
      currentApp = nil
      currentBundleId = nil
      app.terminate()
    }
    let selectorTap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-1","selectorKey":"label","selectorValue":"Search","synthesized":true}"#
    )
    let standardDrag = try runnerCommandFixture(
      #"{"command":"drag","commandId":"drag-1","x":10,"y":20,"x2":30,"y2":40}"#
    )
    let mixedSequence = try runnerCommandFixture(
      """
      {"command":"sequence","commandId":"seq-1","steps":[
        {"kind":"tap","x":10,"y":20,"synthesized":true},
        {"kind":"doubleTap","x":30,"y":40}
      ]}
      """
    )

    XCTAssertFalse(shouldSkipAppActivationPreflight(selectorTap))
    XCTAssertFalse(shouldSkipAppActivationPreflight(standardDrag))
    XCTAssertFalse(shouldSkipAppActivationPreflight(mixedSequence))
  }

  // Launches nothing, but still simulator-only: `shouldSkipAppActivationPreflight` is
  // `#if os(iOS) …guards… #else return false #endif`, so on macOS this asserts a compile-time
  // literal and no edit to the iOS body could make it red. Its five siblings above and below
  // are gated for the same reason.
  func testSkipAppActivationPreflightRequiresCachedForegroundTarget() throws {
    currentApp = nil
    currentBundleId = nil
    let scroll = try runnerCommandFixture(
      #"{"command":"scroll","commandId":"scroll-1","direction":"down","pixels":400}"#
    )

    XCTAssertFalse(shouldSkipAppActivationPreflight(scroll))
  }

  func testSkipAppActivationPreflightKeepsDragScrollAndSequenceOnForegroundGuard() throws {
    app.launch()
    currentApp = app
    currentBundleId = nil
    defer {
      currentApp = nil
      currentBundleId = nil
      app.terminate()
    }
    let drag = try runnerCommandFixture(
      #"{"command":"drag","commandId":"drag-1","x":10,"y":20,"x2":30,"y2":40}"#
    )
    let scroll = try runnerCommandFixture(
      #"{"command":"scroll","commandId":"scroll-1","direction":"down","pixels":400}"#
    )
    let sequence = try runnerCommandFixture(
      """
      {"command":"sequence","commandId":"seq-1","steps":[
        {"kind":"tap","x":10,"y":20,"synthesized":true},
        {"kind":"longPress","x":10,"y":200,"durationMs":300}
      ]}
      """
    )

    XCTAssertFalse(shouldSkipAppActivationPreflight(drag))
    XCTAssertFalse(shouldSkipAppActivationPreflight(scroll))
    XCTAssertFalse(shouldSkipAppActivationPreflight(sequence))
  }

  func testSkipAppActivationPreflightIncludesAlertCommands() throws {
    let alert = try runnerCommandFixture(
      #"{"command":"alert","commandId":"alert-1","action":"get"}"#
    )

    XCTAssertTrue(shouldSkipAppActivationPreflight(alert))
  }
#endif

  func testDispatchReturnsBusyBeforeQueueingMainThreadWork() throws {
    let command = try runnerCommandFixture(#"{"command":"snapshot","commandId":"snapshot-busy"}"#)
    abandonedMainThreadWorkCount = 1
    abandonedMainThreadWorkSince = Date(timeIntervalSinceNow: -2)
    defer {
      abandonedMainThreadWorkCount = 0
      abandonedMainThreadWorkSince = nil
    }

    let response = try execute(command: command)

    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "RUNNER_BUSY")
    XCTAssertTrue(response.error?.message.contains("previous command") == true)
  }

  func testDispatchReturnsWedgedBeforeQueueingMainThreadWork() throws {
    let command = try runnerCommandFixture(#"{"command":"snapshot","commandId":"snapshot-wedged"}"#)
    abandonedMainThreadWorkCount = 1
    abandonedMainThreadWorkSince = Date(timeIntervalSinceNow: -(mainThreadWedgeThreshold + 1))
    defer {
      abandonedMainThreadWorkCount = 0
      abandonedMainThreadWorkSince = nil
    }

    let response = try execute(command: command)

    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "RUNNER_WEDGED")
    XCTAssertTrue(response.error?.hint?.contains("runner session will be restarted") == true)
  }

  func testDispatchRecoverySkipsBookkeepingWhileXCTestChannelOccupied() {
    // The #1244 recovery shape: the modal probe abandoned an XCTest query that is still grinding on
    // main, the capture recovered independently, and its response is ready. The recovery loop must
    // return it without re-entering the main queue for recorded-failure/retry bookkeeping (that hop
    // would block behind the abandoned query and re-stall the command), and a later command must
    // still see the runner busy until the abandoned work drains. Removing the guard regresses this.
    let command = try! JSONDecoder().decode(
      Command.self,
      from: Data(#"{"command":"snapshot","commandId":"recovery-guard"}"#.utf8)
    )
    let recovered = Response(ok: false, error: .targetAppUnavailable(bundleId: nil))

    setAbandonedMainThreadWork(1)
    defer { setAbandonedMainThreadWork(0) }
    guard case .busy = currentMainThreadBusyState() else {
      return XCTFail("expected RUNNER_BUSY while abandoned XCTest work is outstanding")
    }

    var occupiedCalls = 0
    let occupied = try! executeDispatchedWithRecovery(command: command) {
      occupiedCalls += 1
      return recovered
    }
    XCTAssertEqual(occupiedCalls, 1, "recovered response must not retry behind abandoned XCTest work")
    XCTAssertEqual(occupied.ok, false)

    setAbandonedMainThreadWork(0)
    guard case .idle = currentMainThreadBusyState() else {
      return XCTFail("runner should be idle once the abandoned work drained")
    }
    var drainedCalls = 0
    _ = try! executeDispatchedWithRecovery(command: command) {
      drainedCalls += 1
      return recovered
    }
    XCTAssertEqual(drainedCalls, 2, "with the channel free the read-only retry runs once")
  }

  private func setAbandonedMainThreadWork(_ count: Int) {
    mainThreadWorkLock.lock()
    abandonedMainThreadWorkCount = count
    abandonedMainThreadWorkSince = count > 0 ? Date(timeIntervalSinceNow: -1) : nil
    mainThreadWorkLock.unlock()
  }
}
#endif
