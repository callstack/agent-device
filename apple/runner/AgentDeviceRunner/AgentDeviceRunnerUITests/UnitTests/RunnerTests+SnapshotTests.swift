import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  @MainActor
  func testSnapshotAccessibilityUnavailableMarksSparseSnapshotRunnerFatal() {
    mainOwned.app = app
    mainOwned.bundleId = "com.example.app"

    let payload = snapshotAccessibilityUnavailable(
      failure: SnapshotCaptureFailure(
        code: Self.axSnapshotErrorCode,
        message: Self.axSnapshotFailureMessage,
        hint: Self.axSnapshotHint
      )
    )

    XCTAssertEqual(payload.message, "\(Self.axSnapshotFailureMessage) Hint: \(Self.axSnapshotHint)")
    XCTAssertEqual(payload.nodes?.count, 1)
    XCTAssertEqual(payload.nodes?.first?.type, "Application")
    XCTAssertEqual(payload.truncated, true)
    XCTAssertEqual(payload.runnerFatal, true)
    XCTAssertEqual(payload.runnerFatalReason, Self.axSnapshotUnavailableReason)
    // The planned terminal result carries the structured verdict like every other planned
    // snapshot — downstream sparse handling keys off it, not off node shapes.
    XCTAssertEqual(payload.snapshotQuality?.state, .sparse)
    XCTAssertEqual(payload.snapshotQuality?.reasonCode, "ax-rejected")
    XCTAssertEqual(payload.snapshotQuality?.reason, Self.axSnapshotFailureMessage)
    XCTAssertNil(mainOwned.app)
    XCTAssertNil(mainOwned.bundleId)
  }

  func testRecoveredSnapshotMessagePreservesHint() {
    let message = recoveredSnapshotMessage(
      SnapshotCaptureFailure(
        code: Self.axSnapshotErrorCode,
        message: Self.axSnapshotFailureMessage,
        hint: Self.axSnapshotHint
      )
    )

    XCTAssertTrue(message.contains(Self.axSnapshotFailureMessage))
    XCTAssertTrue(message.contains(Self.axSnapshotHint))
  }

  func testRawSnapshotTooLargeFailureIsStructured() {
    let failure = rawSnapshotTooLargeFailure(nodeCount: Self.rawSnapshotMaxNodes + 1)

    XCTAssertEqual(failure.code, Self.rawSnapshotTooLargeCode)
    XCTAssertTrue(failure.message.contains("\(Self.rawSnapshotMaxNodes) nodes"))
    XCTAssertEqual(failure.hint, Self.rawSnapshotTooLargeHint)
  }

  func testSystemModalProbeSliceSharesAndClampsToPlanDeadline() {
    // Fresh plan deadline: the probe gets its full dedicated budget.
    XCTAssertEqual(Self.systemModalProbeSlice(budget: 4, deadlineRemaining: 20), 4)
    // Nearly-spent plan deadline: the probe is clamped so it can't run past the shared budget.
    XCTAssertEqual(Self.systemModalProbeSlice(budget: 4, deadlineRemaining: 1.5), 1.5)
    // Exactly/already exhausted deadline: skip the probe entirely (0), never a negative timeout.
    XCTAssertEqual(Self.systemModalProbeSlice(budget: 4, deadlineRemaining: 0), 0)
    XCTAssertEqual(Self.systemModalProbeSlice(budget: 4, deadlineRemaining: -5), 0)
  }

  func testSnapshotAccessibilityUnavailableQueuesInvalidationBehindAbandonedMainThreadWork() {
    MainActor.assumeIsolated {
      mainOwned.bundleId = "com.example.stale-target"
      mainOwned.accessibilityHealth = .healthy
    }
    defer {
      MainActor.assumeIsolated {
        mainOwned.bundleId = nil
        mainOwned.accessibilityHealth = .unknown
      }
    }

    final class ResultBox {
      var elapsed: TimeInterval?
      var payload: DataPayload?
      var bundleStillCachedWhileBlocked: Bool?
      var healthWhileBlocked: RunnerAccessibilityHealth?
      var abandonedWhileBlocked: Int?
    }
    let box = ResultBox()
    let mainBlocked = DispatchSemaphore(value: 0)
    let releaseMain = DispatchSemaphore(value: 0)
    let finished = expectation(description: "fail-closed capture returned while main was blocked")

    DispatchQueue(label: "agent-device.runner.tests.ax-unavailable-invalidation").async {
      _ = try? self.runMainThreadWork(
        "command_execution",
        timeout: 0,
        timeoutError: Self.mainThreadExecutionTimeoutError
      ) {
        mainBlocked.signal()
        _ = releaseMain.wait(timeout: .now() + 5)
        box.bundleStillCachedWhileBlocked = self.mainOwned.bundleId != nil
        box.healthWhileBlocked = self.mainOwned.accessibilityHealth
        return true
      }
      _ = mainBlocked.wait(timeout: .now() + 2)
      let startedAt = Date()
      box.payload = self.snapshotAccessibilityUnavailable(
        failure: SnapshotCaptureFailure(
          code: Self.axSnapshotErrorCode,
          message: Self.axSnapshotFailureMessage,
          hint: Self.axSnapshotHint
        )
      )
      box.elapsed = Date().timeIntervalSince(startedAt)
      self.mainThreadWorkLock.lock()
      box.abandonedWhileBlocked = self.abandonedMainThreadWorkCount
      self.mainThreadWorkLock.unlock()
      releaseMain.signal()
      finished.fulfill()
    }

    wait(for: [finished], timeout: 8)
    let drainDeadline = Date().addingTimeInterval(2)
    while hasAbandonedMainThreadWork() || MainActor.assumeIsolated({ mainOwned.bundleId }) != nil,
      Date() < drainDeadline
    {
      sleepFor(0.005)
    }

    XCTAssertEqual(box.payload?.runnerFatal, true)
    XCTAssertLessThan(
      box.elapsed ?? .infinity,
      0.5,
      "the fail-closed capture must not wait behind abandoned main-thread work"
    )
    XCTAssertEqual(
      box.bundleStillCachedWhileBlocked,
      true,
      "the invalidation must queue behind the blocked main thread, not run on the command queue"
    )
    XCTAssertEqual(
      box.healthWhileBlocked,
      .healthy,
      "the health write must queue behind the blocked main thread, not run on the command queue"
    )
    XCTAssertEqual(box.abandonedWhileBlocked, 1, "the deferred write must not add an abandoned unit")
    XCTAssertFalse(hasAbandonedMainThreadWork())
    MainActor.assumeIsolated {
      XCTAssertNil(mainOwned.bundleId, "the invalidation must run once the main thread frees")
      XCTAssertEqual(mainOwned.accessibilityHealth, .unavailable)
    }
  }

  func testQuerySweepSliceDeadlineIsTheTierSliceNotThePlanDeadline() {
    let startedAt = Date(timeIntervalSinceReferenceDate: 1_000)
    let slice = startedAt.addingTimeInterval(Self.flatInteractiveFallbackBudget)

    XCTAssertEqual(
      Self.querySweepSliceDeadline(
        startedAt: startedAt,
        planDeadline: startedAt.addingTimeInterval(Self.snapshotPlanBudget)
      ),
      slice
    )
    let nearPlanDeadline = startedAt.addingTimeInterval(Self.flatInteractiveFallbackBudget / 2)
    XCTAssertEqual(
      Self.querySweepSliceDeadline(startedAt: startedAt, planDeadline: nearPlanDeadline),
      nearPlanDeadline
    )
  }

  func testQuerySweepStopsAtTheSliceDeadlineBeforeAQueryThatCannotFinish() {
    let startedAt = Date(timeIntervalSinceReferenceDate: 1_000)
    let sliceDeadline = Self.querySweepSliceDeadline(
      startedAt: startedAt,
      planDeadline: startedAt.addingTimeInterval(Self.snapshotPlanBudget)
    )
    var clock = startedAt
    var startedQueries: [Int] = []

    let sweep = Self.runFlatInteractiveQueries(
      Array(0..<19),
      deadline: sliceDeadline,
      now: { clock }
    ) { query -> (elements: [Int], axUnavailable: Bool) in
      startedQueries.append(query)
      clock = clock.addingTimeInterval(0.475)
      return ([query], false)
    }

    XCTAssertEqual(startedQueries, [0, 1], "a query must not start with less than one query budget left")
    XCTAssertEqual(sweep.elements, [0, 1])
    XCTAssertEqual(sweep.outcome, .deadlineExhausted)
    XCTAssertLessThanOrEqual(clock, sliceDeadline, "no started query may outlive the tier slice")

    XCTAssertTrue(
      Self.querySweepCanStartQuery(deadline: sliceDeadline, now: sliceDeadline.addingTimeInterval(-0.2))
    )
    XCTAssertFalse(
      Self.querySweepCanStartQuery(deadline: sliceDeadline, now: sliceDeadline.addingTimeInterval(-0.05))
    )
    XCTAssertFalse(Self.querySweepCanStartQuery(deadline: sliceDeadline, now: sliceDeadline))
  }

  func testQuerySweepRunsEveryQueryThatFitsAndStopsOnAXUnavailable() {
    let startedAt = Date(timeIntervalSinceReferenceDate: 1_000)
    let deadline = startedAt.addingTimeInterval(Self.flatInteractiveFallbackBudget)

    let complete = Self.runFlatInteractiveQueries(
      [0, 1, 2],
      deadline: deadline,
      now: { startedAt }
    ) { query -> (elements: [Int], axUnavailable: Bool) in ([query], false) }
    XCTAssertEqual(complete.elements, [0, 1, 2])
    XCTAssertEqual(complete.outcome, .completed)

    let rejected = Self.runFlatInteractiveQueries(
      [0, 1, 2],
      deadline: deadline,
      now: { startedAt }
    ) { query -> (elements: [Int], axUnavailable: Bool) in ([query], query == 1) }
    XCTAssertEqual(rejected.elements, [0, 1])
    XCTAssertEqual(
      rejected.outcome,
      .completed,
      "an AX refusal ends the sweep on its own terms, not on the deadline"
    )
  }

  // Simulator-only: the bounded probe body returns nil on macOS (no SpringBoard host), so the
  // timeout/penalty/drain machinery below only exists on the iOS branch.
#if os(iOS)
  /// Regression for #1244/#1248: drives the bounded system-modal probe through a real,
  /// production-only command entry point (`snapshotFast` or `snapshotRaw` -- see the two test
  /// methods below), not `boundedBlockingSystemAlertSnapshot` directly, with
  /// `systemModalProbeOverrideForTesting` set to a closure that blocks past the probe's real
  /// slice, forcing a real `runMainThreadWork` timeout. This is revert-sensitive on both halves
  /// of the fix, for either entry point:
  ///   - if the entry point reverted to calling the unbounded `blockingSystemAlertSnapshot`
  ///     directly (or dropped the `runMainThreadWork` wrap), nothing here would ever time out,
  ///     so the mid-flight busy/penalty assertions below would never be met;
  ///   - if the `onAbandoned` penalty hook or the abandoned-work accounting were dropped, the
  ///     timeout would still fire, but the busy/penalty and drain assertions would not hold.
  ///
  /// The drain assertion is synchronized on the *real* release rather than raced: after
  /// signaling the probe to finish, the background queue polls `hasAbandonedMainThreadWork()`
  /// (bounded) and only then fulfills `drained`, which the test `wait(for:timeout:)`s on before
  /// asserting `.idle`/`hasAbandonedMainThreadWork() == false` below -- so a slow drain fails that
  /// assertion instead of racing a fixed-timing guess.
  private func assertBoundedSystemModalProbeTimeoutRecoversThenReleasesOnDrain(
    entryPointName: String,
    callEntryPoint: @escaping (SnapshotCaptureTarget, PresentationOptions) throws -> DataPayload
  ) {
    let targetBundleId = "com.callstack.agentdevice.runner.missing.snapshot-timeout-test"
    let snapshotTarget = XCUIApplication(bundleIdentifier: targetBundleId)
    let probeReleaseGate = DispatchSemaphore(value: 0)
    let captureTarget = MainActor.assumeIsolated {
      mainOwned.app = snapshotTarget
      mainOwned.bundleId = targetBundleId
      return takeSnapshotCaptureTarget(app: snapshotTarget)
    }
    defer {
      probeReleaseGate.signal()
      MainActor.assumeIsolated {
        mainOwned.app = nil
        mainOwned.bundleId = nil
      }
      systemModalProbeOverrideForTesting = nil
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
    }

    final class ResultBox {
      var payload: DataPayload?
      var wasBusyBeforeDrain = false
      var hadAbandonedCaptureBeforeDrain = false
      var wasPenalizedBeforeDrain = false
    }
    let box = ResultBox()
    // The test owns release of the injected probe. A fixed timeout races the capture plan's
    // independent fallback tiers on loaded CI hosts and can drain before the test records the
    // abandoned-work state. The defer above still releases the probe if an earlier assertion or
    // expectation fails.
    systemModalProbeOverrideForTesting = { _ in
      probeReleaseGate.wait()
      return nil
    }

    let completion = expectation(
      description: "\(entryPointName) recovered while the probe was abandoned, then released it"
    )
    let drained = expectation(description: "\(entryPointName) modal probe drained")
    DispatchQueue(label: "agent-device.runner.tests.modal-probe-timeout").async {
      box.payload = try? callEntryPoint(
        captureTarget,
        PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false)
      )

      // 1) Penalty/busy accounting: must already be in place by the time the entry point
      // returns, well before we release the still-blocked probe below.
      if case .busy = self.currentMainThreadBusyState() {
        box.wasBusyBeforeDrain = true
      }
      box.hadAbandonedCaptureBeforeDrain = self.hasAbandonedMainThreadWork()
      box.wasPenalizedBeforeDrain = self.isSnapshotXCTestChannelPenalized(bundleId: targetBundleId)

      // 2) `box.payload` above was already produced -- through the capture plan's recovery
      // tiers -- while the probe is still blocked on `probeReleaseGate`, i.e. recovered before
      // drain, not queued behind it.
      completion.fulfill()

      // 3) Only now let the abandoned probe finish, then block this queue (never the test's
      // main-thread wait) on the *real* drain signal -- the abandoned-work count reaching zero
      // -- bounded so a revert that never drains fulfills `drained` anyway and lets the
      // assertions below report the regression explicitly instead of just timing out.
      probeReleaseGate.signal()
      let drainDeadline = Date().addingTimeInterval(5)
      while self.hasAbandonedMainThreadWork(), Date() < drainDeadline {
        self.sleepFor(0.002)
      }
      drained.fulfill()
    }

    wait(for: [completion], timeout: 15)

    // 1) Penalty/busy accounting.
    XCTAssertTrue(
      box.wasBusyBeforeDrain,
      "expected RUNNER_BUSY while the \(entryPointName) modal probe timeout is outstanding"
    )
    XCTAssertTrue(
      box.hadAbandonedCaptureBeforeDrain,
      "onAbandoned must retain the abandoned XCTest channel work for \(entryPointName)"
    )
    XCTAssertTrue(
      box.wasPenalizedBeforeDrain,
      "a timed-out modal probe must penalize the XCTest snapshot channel for \(entryPointName)"
    )

    // 2) Recovered response before drain.
    XCTAssertNotNil(
      box.payload,
      "\(entryPointName) must recover a payload through the capture plan while the probe drains"
    )

    // 3) Bounded, deterministic drain barrier, then release assertions.
    wait(for: [drained], timeout: 6)
    guard case .idle = currentMainThreadBusyState() else {
      return XCTFail("expected the runner to be idle once the abandoned \(entryPointName) probe drained")
    }
    XCTAssertFalse(
      hasAbandonedMainThreadWork(),
      "the drained probe must release the main thread for \(entryPointName)"
    )
  }

  func testBoundedSystemModalProbeTimeoutRecoversThenReleasesOnDrain() {
    assertBoundedSystemModalProbeTimeoutRecoversThenReleasesOnDrain(entryPointName: "snapshotFast") {
      target, options in
      try self.snapshotFast(target: target, options: options)
    }
  }

  func testBoundedSystemModalProbeTimeoutRecoversThenReleasesOnDrainForSnapshotRaw() {
    assertBoundedSystemModalProbeTimeoutRecoversThenReleasesOnDrain(entryPointName: "snapshotRaw") {
      target, options in
      try self.snapshotRaw(target: target, options: options)
    }
  }
#endif
}
#endif
