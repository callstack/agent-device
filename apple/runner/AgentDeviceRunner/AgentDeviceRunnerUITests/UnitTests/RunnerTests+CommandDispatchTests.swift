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
    // the only evidence the press landed. That is why the press declares `convertsRecordedFailure`
    // even though its launch policy keeps it out of the app-activation preflight (#2699, #2702).
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
  @MainActor
  func testObserveOnlySnapshotRefusesBackgroundWithoutActivationOrDisclosure() throws {
    app.launch()
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
    pendingTargetActivation = nil
    defer { app.terminate() }
    let command = try runnerCommandFixture(
      "{\"command\":\"snapshot\",\"appBundleId\":\"com.callstack.agentdevice.runner\",\"observeOnly\":true}"
    )
    guard case .response(let response) = prepareActiveCommandContext(command: command) else {
      return XCTFail("observe-only must refuse a background target")
    }
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "OBSERVATION_UNAVAILABLE")
    XCTAssertEqual(app.state, .runningBackground)
    XCTAssertNil(pendingTargetActivation)
    XCTAssertNil(response.data?.targetActivation)
  }

  @MainActor
  func testObserveOnlySnapshotReportsStateWithoutBindingOrActivatingTarget() throws {
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    invalidateCachedTarget(reason: "unit_test_setup")
    pendingTargetActivation = nil
    defer { app.terminate() }
    let command = try runnerCommandFixture(
      "{\"command\":\"snapshot\",\"appBundleId\":\"com.callstack.agentdevice.runner\",\"observeOnly\":true}"
    )
    guard case .context(let context) = prepareActiveCommandContext(command: command) else {
      return XCTFail("observe-only must accept the reported foreground state")
    }
    XCTAssertEqual(context.observation?.mode, "observe-only")
    XCTAssertEqual(context.observation?.activationPerformed, false)
    XCTAssertEqual(context.observation?.appState, "runningForeground")
    XCTAssertEqual(context.observation?.appStateSource, "xcuiapplication-state")
    XCTAssertNil(context.systemSurface)
    XCTAssertNil(mainOwned.bundleId)
    XCTAssertNil(pendingTargetActivation)
  }

  @MainActor
  func testRegularSnapshotStillRepairsBackgroundAndDisclosesPriorState() throws {
    app.launch()
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
    pendingTargetActivation = nil
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      pendingTargetActivation = nil
      app.terminate()
    }
    let command = try runnerCommandFixture(
      "{\"command\":\"snapshot\",\"appBundleId\":\"com.callstack.agentdevice.runner\"}"
    )
    guard case .context(let context) = prepareActiveCommandContext(command: command) else {
      return XCTFail("regular snapshot must keep the foreground repair")
    }
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    XCTAssertNil(context.observation)
    XCTAssertEqual(pendingTargetActivation?.priorState, Int(XCUIApplication.State.runningBackground.rawValue))
    XCTAssertEqual(pendingTargetActivation?.reason, "stale_target")
  }

  @MainActor
  func testMissingBundleCommandInvalidatesCompleteCachedTargetState() throws {
    app.launch()
    mainOwned.app = app
    mainOwned.bundleId = "com.example.stale-target"
    mainOwned.processIdentifier = 42
    snapshotXCTestPenaltyWarmupExemption.isPending = true
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let command = try runnerCommandFixture(
      #"{"command":"snapshot","commandId":"snapshot-without-bundle"}"#
    )

    _ = prepareActiveCommandContext(command: command)

    XCTAssertNil(mainOwned.app)
    XCTAssertNil(mainOwned.bundleId)
    XCTAssertNil(mainOwned.processIdentifier)
    XCTAssertFalse(snapshotXCTestPenaltyWarmupExemption.isPending)
  }

  /// A `.presentedSurface` command is the activation bypass itself: it resolves its target as it
  /// stands, leaves a stopped app stopped, and binds nothing, so the next read of that app is refused
  /// instead of answered by a bare launch (#2890). This is where the table's launch policy is proved
  /// on the platform that serves surfaces in place.
  @MainActor
  func testPresentedSurfaceCommandLeavesAStoppedAppStoppedAndUnbound() throws {
    let unstarted = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
    defer { invalidateCachedTarget(reason: "unit_test_cleanup") }
    for request in [
      #"{"command":"actionButton","commandId":"press-1","appBundleId":"com.apple.Preferences"}"#,
      #"{"command":"alert","action":"get","commandId":"alert-1","appBundleId":"com.apple.Preferences"}"#
    ] {
      unstarted.terminate()
      pendingTargetActivation = nil
      mainOwned.app = nil
      mainOwned.bundleId = nil
      let command = try runnerCommandFixture(request)

      guard case .context(let prepared) = prepareActiveCommandContext(command: command) else {
        return XCTFail("\(request) must be prepared, not refused")
      }
      // Leaving the app stopped is only half of the bypass. The command must still be served against
      // the app it names: a hosted alert belongs to that app, and routing the request to SpringBoard
      // or to the runner's own host app would answer a different screen than the caller asked about —
      // with nothing launched, so no assertion below would notice. The stopped app is the only target
      // that reads as `.notRunning`, which is what separates it from every substitute.
      XCTAssertEqual(
        prepared.app.state,
        .notRunning,
        "\(request) must be prepared against the stopped app it names, not a live surface"
      )
      XCTAssertNil(
        prepared.systemSurface,
        "\(request) must be served from the named app, not from a surface presented over it"
      )
      XCTAssertEqual(
        unstarted.state,
        .notRunning,
        "\(request) may not foreground the app it was told to leave alone"
      )
      XCTAssertNil(pendingTargetActivation, "\(request) may not record an activation fact")
      XCTAssertNil(mainOwned.bundleId, "\(request) may not bind a target it never brought forward")
    }

    let read = try runnerCommandFixture(
      #"{"command":"snapshot","commandId":"read","appBundleId":"com.apple.Preferences"}"#
    )
    guard case .response(let refusal) = prepareActiveCommandContext(command: read),
      refusal.error?.code == RunnerWireErrorCode.appNotRunning
    else {
      return XCTFail("a command that bound no target must leave the next read refused, not launched")
    }
  }

  /// Pins the `.noApp` preparation contract in `prepareActiveCommandContext`: a presented host is
  /// served in place with its surface disclosed, and with nothing presented the standing cached
  /// target is served rather than one resolved from the request. The request names a bundle the
  /// session never bound because that is the only shape separating the two targets — when the
  /// request agrees with the cache, both answers name the same app. The override is authoritative
  /// for every registered host while set, so no live state is read; the probe's registry walk and
  /// foreground condition stay the production ones. Deleting the presented arm fails the first
  /// block, and resolving the target from the request instead of the cache fails the last.
  @MainActor
  func testNoAppCommandStillServesAPresentedSurfaceInPlaceAndOtherwiseTheStandingTarget() throws {
    let cachedBundleId = "com.example.session"
    let requestedBundleId = "com.example.requested-but-never-bound"
    defer {
      presentedSystemSurfaceForegroundOverrideForTesting = nil
      invalidateCachedTarget(reason: "unit_test_cleanup")
    }

    let host = try XCTUnwrap(SystemSurfaceHostRegistry.hosts.first)
    let screenshot = try runnerCommandFixture(
      #"{"command":"screenshot","commandId":"capture-1","appBundleId":"\#(requestedBundleId)"}"#
    )
    mainOwned.app = app
    mainOwned.bundleId = cachedBundleId

    presentedSystemSurfaceForegroundOverrideForTesting = [host.bundleId]
    guard case .context(let presented) = prepareActiveCommandContext(command: screenshot) else {
      return XCTFail("screenshot must be prepared, not refused")
    }
    XCTAssertEqual(
      presented.systemSurface,
      host,
      "a capture prepared under a presented surface must name that surface as its prepared subject (#2438)"
    )
    XCTAssertFalse(
      presented.app === app,
      "the prepared subject is the presented host, not the standing session target"
    )
    XCTAssertFalse(
      presented.app === springboard,
      "a presented surface is served in place, never through SpringBoard"
    )
    XCTAssertNil(pendingTargetActivation, "serving a surface in place may not record an activation")
    XCTAssertEqual(
      mainOwned.bundleId,
      cachedBundleId,
      "serving a surface in place may not rebind the session target"
    )

    // A second host reported instead of the first: an arm that returned the registry's first entry
    // rather than walking it would pass everything above and fail here. The total override makes the
    // first host's not-foreground answer pinned too, not merely observed.
    let secondHost = SystemSurfaceHostRegistry.hosts[1]
    presentedSystemSurfaceForegroundOverrideForTesting = [secondHost.bundleId]
    guard case .context(let other) = prepareActiveCommandContext(command: screenshot) else {
      return XCTFail("screenshot must be prepared, not refused")
    }
    XCTAssertEqual(
      other.systemSurface,
      secondHost,
      "the probe must serve the host that is reported foreground, not the registry's first entry"
    )

    // Both reported: the registry's own order decides, because live state cannot be told to present
    // two hosts at once. Totality is what keeps the block's answer free of what the sim happens to
    // report for any host a future registry entry adds.
    presentedSystemSurfaceForegroundOverrideForTesting = [host.bundleId, secondHost.bundleId]
    guard case .context(let both) = prepareActiveCommandContext(command: screenshot) else {
      return XCTFail("screenshot must be prepared, not refused")
    }
    XCTAssertEqual(
      both.systemSurface,
      host,
      "with every host foreground the probe must serve them in registry order"
    )

    // The other half, with nothing presented — an empty total override, so this half pins the
    // hosts' answers too. Without this the arm could pass by serving a surface that is not there.
    presentedSystemSurfaceForegroundOverrideForTesting = []
    guard case .context(let standing) = prepareActiveCommandContext(command: screenshot) else {
      return XCTFail("screenshot must be prepared, not refused")
    }
    XCTAssertNil(
      standing.systemSurface,
      "no surface is presented, so nothing may be disclosed as one"
    )
    XCTAssertTrue(
      standing.app === app,
      "naming another bundle is no licence to point the observation away from the standing target"
    )
    XCTAssertNil(pendingTargetActivation)
    XCTAssertEqual(mainOwned.bundleId, cachedBundleId, "preparing a capture binds nothing")
  }

  @MainActor
  func testSkipAppActivationPreflightRequiresCachedForegroundCoordinateOnlyTap() throws {
    let coordinateTap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-1","x":10,"y":20}"#
    )
    let scroll = try runnerCommandFixture(
      #"{"command":"scroll","commandId":"scroll-1","direction":"down","pixels":400}"#
    )
    mainOwned.app = nil
    mainOwned.bundleId = nil
    XCTAssertFalse(shouldSkipAppActivationPreflight(coordinateTap), "a tap needs a cached target")
    XCTAssertFalse(shouldSkipAppActivationPreflight(scroll), "a scroll needs a cached target")

    app.launch()
    mainOwned.app = app
    defer {
      mainOwned.app = nil
      mainOwned.bundleId = nil
      app.terminate()
    }
    XCTAssertEqual(app.state, .runningForeground)
    XCTAssertTrue(shouldSkipAppActivationPreflight(coordinateTap))

    let guardedCommands: [(String, String)] = [
      ("selector tap", #"{"command":"tap","commandId":"selector-tap","selectorKey":"label","selectorValue":"Search","synthesized":true}"#),
      ("mixed sequence", """
      {"command":"sequence","commandId":"mixed-sequence","steps":[
        {"kind":"tap","x":10,"y":20,"synthesized":true},
        {"kind":"doubleTap","x":30,"y":40}
      ]}
      """),
      ("drag", #"{"command":"drag","commandId":"drag-1","x":10,"y":20,"x2":30,"y2":40}"#),
      ("scroll", #"{"command":"scroll","commandId":"scroll-2","direction":"down","pixels":400}"#),
      ("sequence", """
      {"command":"sequence","commandId":"seq-1","steps":[
        {"kind":"tap","x":10,"y":20,"synthesized":true},
        {"kind":"longPress","x":10,"y":200,"durationMs":300}
      ]}
      """)
    ]
    for (name, json) in guardedCommands {
      let command = try runnerCommandFixture(json)
      XCTAssertFalse(shouldSkipAppActivationPreflight(command), name)
    }

    mainOwned.bundleId = "com.example.current"
    let changedBundleTap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-2","appBundleId":"com.example.other","x":10,"y":20}"#
    )
    XCTAssertFalse(shouldSkipAppActivationPreflight(changedBundleTap), "a different bundle needs activation")

    app.terminate()
    mainOwned.bundleId = nil
    XCTAssertEqual(app.state, .notRunning)
    XCTAssertFalse(shouldSkipAppActivationPreflight(coordinateTap), "a terminated cached target needs activation")
  }

  @MainActor
  func testPrepareActiveCommandContextRoutesBlockingSystemModalToSpringboard() throws {
    blockingSystemModalPresenceOverrideForTesting = true
    mainOwned.app = nil
    mainOwned.bundleId = nil
    defer {
      blockingSystemModalPresenceOverrideForTesting = nil
      mainOwned.app = nil
      mainOwned.bundleId = nil
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
    MainActor.assumeIsolated {
      mainOwned.app = app
      mainOwned.bundleId = nil
    }
    defer {
      MainActor.assumeIsolated {
        mainOwned.app = nil
        mainOwned.bundleId = nil
      }
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
    MainActor.assumeIsolated {
      mainOwned.app = app
      mainOwned.bundleId = pendingBundleId
    }
    snapshotXCTestPenaltyWarmupExemption.isPending = false
    clearSnapshotXCTestChannelPenalty(reason: "test-setup")
    defer {
      systemModalProbeOverrideForTesting = nil
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      MainActor.assumeIsolated {
        invalidateCachedTarget(reason: "unit_test_cleanup")
      }
      app.terminate()
    }

    // Occupy main and rebind the target inside that block: every identity read that arrives while it
    // is queued sees a target that main is on its way to replacing.
    let mainRelease = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      _ = mainRelease.wait(timeout: .now() + 0.5)
      self.mainOwned.bundleId = settledBundleId
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
    XCTAssertEqual(drainedCalls, 2, "with the channel free the session-loss retry runs once")
  }

  private func setAbandonedMainThreadWork(_ count: Int) {
    mainThreadWorkLock.lock()
    abandonedMainThreadWorkCount = count
    abandonedMainThreadWorkSince = count > 0 ? Date(timeIntervalSinceNow: -1) : nil
    mainThreadWorkLock.unlock()
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(macOS)
extension RunnerTests {
  /// Part of every macOS install, never the runner or the test host, and cheap to leave terminated.
  /// Its windows sit over or behind the test host's own, which is exactly the desktop shape #3254
  /// describes: the user's frontmost app is a different app from the session app.
  private static let macBackgroundTargetBundleId = "com.apple.systempreferences"
  private static let macForegroundStealBundleId = "com.apple.finder"

  /// Brings Settings up, then hands the foreground to Finder, and waits until Settings reports
  /// itself background. `activate()` on another app is how a desktop backgrounds an app without
  /// quitting it, so this leaves the state a read must answer — not a launchable absence.
  @MainActor
  private func startMacTargetAndLoseTheForeground() throws -> XCUIApplication {
    let target = XCUIApplication(bundleIdentifier: Self.macBackgroundTargetBundleId)
    target.launch()
    XCTAssertTrue(target.waitForFixtureExistence(timeout: appExistenceTimeout))
    _ = XCUIApplication(bundleIdentifier: Self.macForegroundStealBundleId).activate()
    XCTAssertTrue(
      target.wait(for: .runningBackground, timeout: 10),
      "Finder must take the foreground and the target must settle background before the read answers from it"
    )
    return target
  }

  /// The #3254 fix on the policy axis: on macOS a `.existingApp` read of a session app that is
  /// running behind other windows is served from where it sits. Three things must be true at once:
  /// the command is prepared against the app it names, no activation fact is booked (the response
  /// therefore discloses no repair because none happened), and the app is still background when the
  /// read is done — the user's frontmost app never changed. Covers the user-level read and the two
  /// leading reads an interaction carries (gesture viewport, selector resolution), the same shapes
  /// the iOS surface arm pins. Deleting the macOS arm of `.existingApp` fails every row.
  @MainActor
  func testMacReadOfABackgroundAppIsServedInBackgroundWithoutActivating() throws {
    let target = try startMacTargetAndLoseTheForeground()
    let bundleId = Self.macBackgroundTargetBundleId
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      pendingTargetActivation = nil
      target.terminate()
    }
    for request in [
      #"{"command":"snapshot","commandId":"read","appBundleId":"\#(bundleId)"}"#,
      #"{"command":"gestureViewport","commandId":"read","appBundleId":"\#(bundleId)"}"#,
      #"{"command":"querySelector","selectorKey":"label","selectorValue":"General","commandId":"read","appBundleId":"\#(bundleId)"}"#
    ] {
      invalidateCachedTarget(reason: "unit_test_setup")
      pendingTargetActivation = nil
      let command = try runnerCommandFixture(request)

      guard case .context(let prepared) = prepareActiveCommandContext(command: command) else {
        return XCTFail("\(request) must be served, not refused")
      }
      XCTAssertEqual(
        prepared.app.state,
        .runningBackground,
        "\(request) must be served against the background app it names"
      )
      XCTAssertNil(pendingTargetActivation, "\(request) may not book an activation fact")
      // The disclosure decision, pinned with #3254: a background-served read answers as an ordinary
      // read with no substitute marker (no observation payload, no fact). The tree is live, not
      // degraded; a future disclosure must edit this line on purpose.
      XCTAssertNil(prepared.observation, "\(request) must not invent an observation payload")
      XCTAssertEqual(
        target.state,
        .runningBackground,
        "\(request) may not take the user's frontmost app away"
      )
    }
  }

  /// The identity rule the served read must go through (#3254 review): with the cache bound to a
  /// pid an outside relaunch replaced, a served read answers the process a bound read would have
  /// read, not the dead handle the cache holds. The bogus cached pid makes the wiring observable:
  /// the served preparation must leave the live pid behind, so deleting the
  /// `refreshCachedTargetIfProcessChanged` call from the arm leaves the bogus value and fails here.
  @MainActor
  func testMacBackgroundReadRefreshesACachedHandleFromADeadPid() throws {
    let target = try startMacTargetAndLoseTheForeground()
    let bundleId = Self.macBackgroundTargetBundleId
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      pendingTargetActivation = nil
      target.terminate()
    }
    let command = try runnerCommandFixture(
      #"{"command":"snapshot","commandId":"read","appBundleId":"\#(bundleId)"}"#
    )
    // Plant the residue an outside relaunch leaves between two reads: the cache still names this
    // app and still holds a handle, but the pid it recorded is dead.
    mainOwned.app = target
    mainOwned.bundleId = bundleId
    mainOwned.processIdentifier = 999_999
    pendingTargetActivation = nil

    guard case .context(let prepared) = prepareActiveCommandContext(command: command) else {
      return XCTFail("the read must be served")
    }
    XCTAssertEqual(prepared.app.state, .runningBackground, "still served in place")
    XCTAssertNil(pendingTargetActivation, "the refresh must not activate")
    XCTAssertNotEqual(
      mainOwned.processIdentifier,
      999_999,
      "a served read must run the shared identity refresh, not answer from a dead pid"
    )
  }

  /// The scope limit that keeps this from being a blanket no-activate rule: an interaction against
  /// the same background app still comes forward through the same preparation, because on macOS the
  /// XCTest path drives events into the foreground window and a background click would land on
  /// whatever window sits on top. This is the same call with `.mayLaunch`; the two tests above and
  /// this one together pin the boundary the policy axis draws.
  @MainActor
  func testMacInteractionOnABackgroundAppStillActivates() throws {
    let target = try startMacTargetAndLoseTheForeground()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      pendingTargetActivation = nil
      target.terminate()
    }
    invalidateCachedTarget(reason: "unit_test_setup")
    pendingTargetActivation = nil
    let command = try runnerCommandFixture(
      #"{"command":"tap","x":10,"y":10,"commandId":"tap-bg","appBundleId":"\#(Self.macBackgroundTargetBundleId)"}"#
    )

    guard case .context = prepareActiveCommandContext(command: command) else {
      return XCTFail("the tap must be prepared")
    }
    XCTAssertNotNil(
      pendingTargetActivation,
      "an interaction on a background app must still book its activation"
    )
    XCTAssertEqual(target.state, .runningForeground, "the tap must run against the foreground app")
  }

  /// Stopped apps behave exactly as they did before this axis read macOS (#3254 correction): a read
  /// of a not-running session app still goes through the activating route and the launch it performs,
  /// because macOS has no refusal there and callers rely on `open`-then-read working. `snapshot` is
  /// the read whose policy the background change touched, so it is the read that proves the change is
  /// scoped to the running app only: the app comes up, the activation fact is booked, and nothing is
  /// refused. Making `macReadMayBeServedInBackground` answer `.notRunning` too would turn this
  /// context into a refusal and fail on the first assertion.
  @MainActor
  func testMacReadOfANotRunningAppStillLaunchesIt() throws {
    let target = XCUIApplication(bundleIdentifier: Self.macBackgroundTargetBundleId)
    target.terminate()
    invalidateCachedTarget(reason: "unit_test_setup")
    pendingTargetActivation = nil
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      pendingTargetActivation = nil
      target.terminate()
    }
    let command = try runnerCommandFixture(
      #"{"command":"snapshot","commandId":"read","appBundleId":"\#(Self.macBackgroundTargetBundleId)"}"#
    )

    guard case .context = prepareActiveCommandContext(command: command) else {
      return XCTFail("a read of a stopped app must keep the launch route it has always had")
    }
    XCTAssertNotEqual(target.state, .notRunning, "the stopped app must come up as it did before")
    XCTAssertNotNil(
      pendingTargetActivation,
      "the command that launched the app discloses the activation it paid for"
    )
  }
}
#endif
