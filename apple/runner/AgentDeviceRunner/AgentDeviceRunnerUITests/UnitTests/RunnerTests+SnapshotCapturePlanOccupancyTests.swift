import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

/// Per-run gate for `RunnerBlockingSnapshotStub`: the swizzled IMP cannot capture a test-local
/// semaphore, and one shared across runs would carry leftover signals into the next run.
private enum RunnerBlockingSnapshotGate {
  static var release = DispatchSemaphore(value: 0)
  static var entered = DispatchSemaphore(value: 0)
}

/// Stands in for `-[XCUIElement snapshotWithError:]` so the tree tier's XPC grinds the way it does
/// on a live Bluesky feed: it blocks the main thread until the test releases it, then fails like a
/// read the AX server gave up on. The swap is process-wide while installed, which serial XCTest
/// execution tolerates.
private final class RunnerBlockingSnapshotStub: NSObject {
  /// Far past the plan deadline, so only the test's own release ends the block; it only stops a
  /// stuck test from holding the main thread.
  private static let leakGuard: TimeInterval = 75

  @objc(snapshotWithError:)
  func snapshot() throws -> XCUIElementSnapshot {
    RunnerBlockingSnapshotGate.entered.signal()
    _ = RunnerBlockingSnapshotGate.release.wait(timeout: .now() + Self.leakGuard)
    throw NSError(
      domain: "AgentDeviceRunner.tests",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "blocked tree snapshot released"]
    )
  }
}

/// Records when each `RunnerSlowSweepQueryStub` query started. The swizzled IMP cannot capture
/// test-local state, so each run resets it.
private enum RunnerSlowSweepQueryGate {
  /// Shorter than `flatInteractiveQueryBudget`, so a sweep that stops at its slice deadline never
  /// outlives the slice; a full sweep of these outlasts the slice, so one that ignores it does.
  static let queryDuration: TimeInterval = 0.06
  private static let lock = NSLock()
  private static var starts: [Date] = []

  static func reset() {
    lock.lock()
    starts = []
    lock.unlock()
  }

  static func recordStart() {
    lock.lock()
    starts.append(Date())
    lock.unlock()
  }

  static func recordedStarts() -> [Date] {
    lock.lock()
    defer { lock.unlock() }
    return starts
  }
}

/// Stands in for `-[XCUIElementQuery allElementsBoundByIndex]` so every query the sweep runs holds
/// the main thread for a fixed time and finds nothing.
private final class RunnerSlowSweepQueryStub: NSObject {
  @objc var allElementsBoundByIndex: [XCUIElement] {
    RunnerSlowSweepQueryGate.recordStart()
    Thread.sleep(forTimeInterval: RunnerSlowSweepQueryGate.queryDuration)
    return []
  }
}

extension RunnerTests {
  /// The Bluesky feed shape: the tree XPC grinds past its slice. The plan must recover through
  /// private AX without queueing the query sweep behind the abandoned XPC, and a fresh process's
  /// first capture must not be penalized for the slice it lost.
  func testAbandonedTreeCaptureSkipsQuerySweepAndHonorsWarmupExemption() throws {
    guard
      let snapshotMethod = class_getInstanceMethod(
        XCUIApplication.self,
        #selector(XCUIElement.snapshot)
      ),
      let stubMethod = class_getInstanceMethod(
        RunnerBlockingSnapshotStub.self,
        #selector(RunnerBlockingSnapshotStub.snapshot)
      )
    else {
      XCTFail("unable to install the blocking snapshot stub")
      return
    }
    app.launchArguments = ["--agent-device-selector-read-regression"]
    app.launch()
    // Resolve the application element while nothing is stubbed: on a fresh simulator the first
    // resolution is slow, and it must not be the block the plan abandons.
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    XCTAssertFalse(app.frame.isEmpty)
    snapshotXCTestPenaltyWarmupExemption.isPending = true
    let captureTarget = MainActor.assumeIsolated {
      mainOwned.app = app
      mainOwned.bundleId = "com.callstack.agentdevice.runner.tree-capture-test"
      return takeSnapshotCaptureTarget(app: app)
    }
    RunnerBlockingSnapshotGate.release = DispatchSemaphore(value: 0)
    RunnerBlockingSnapshotGate.entered = DispatchSemaphore(value: 0)
    let originalImplementation = method_getImplementation(snapshotMethod)
    method_setImplementation(snapshotMethod, method_getImplementation(stubMethod))
    defer {
      RunnerBlockingSnapshotGate.release.signal()
      method_setImplementation(snapshotMethod, originalImplementation)
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      clearPrivateAXAcceptedDepth(reason: "test-cleanup")
      MainActor.assumeIsolated {
        invalidateCachedTarget(reason: "unit_test_cleanup")
      }
      app.terminate()
    }

    final class ResultBox {
      var payload: DataPayload?
      var error: Error?
      var abandonedAfterPlan: Int?
      var penalizedAfterPlan: Bool?
      var blockingTreeEntered = false
    }
    let box = ResultBox()
    let planned = expectation(description: "capture plan answered while the tree XPC grinds")
    DispatchQueue(label: "agent-device.runner.tests.plan-occupancy").async {
      do {
        box.payload = try self.runSnapshotCapturePlan(
          Self.regularVisiblePlan,
          target: captureTarget,
          options: PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false),
          terminal: .sparseWithFatalOnAXFailure,
          deadline: Date().addingTimeInterval(12)
        )
      } catch {
        box.error = error
      }
      self.mainThreadWorkLock.lock()
      box.abandonedAfterPlan = self.abandonedMainThreadWorkCount
      self.mainThreadWorkLock.unlock()
      box.penalizedAfterPlan = self.isSnapshotXCTestChannelPenalized(bundleId: captureTarget.bundleId)
      box.blockingTreeEntered = RunnerBlockingSnapshotGate.entered.wait(timeout: .now()) == .success
      RunnerBlockingSnapshotGate.release.signal()
      planned.fulfill()
    }

    wait(for: [planned], timeout: 60)
    let drainDeadline = Date().addingTimeInterval(3)
    while hasAbandonedMainThreadWork(), Date() < drainDeadline {
      sleepFor(0.005)
    }

    XCTAssertNil(box.error)
    XCTAssertTrue(box.blockingTreeEntered, "the tree XPC must enter before the plan answers")
    let quality = try XCTUnwrap(box.payload?.snapshotQuality)
    XCTAssertEqual(quality.backend, SnapshotBackendKind.privateAX.rawValue)
    XCTAssertEqual(quality.state, .recovered)
    XCTAssertTrue(
      quality.reason?.contains("tree capture exceeded") == true,
      "the tree XPC, not the viewport read, must be the abandoned block: \(quality.reason ?? "nil")"
    )
    XCTAssertGreaterThan(box.payload?.nodes?.count ?? 0, 1)
    XCTAssertEqual(
      box.abandonedAfterPlan,
      1,
      "only the tree XPC may be abandoned; a query sweep queued behind it would make it 2"
    )
    XCTAssertEqual(
      box.penalizedAfterPlan,
      false,
      "the fresh-process warmup exemption must cover the tree tier's slice timeout"
    )
    XCTAssertFalse(hasAbandonedMainThreadWork())
    guard case .idle = currentMainThreadBusyState() else {
      return XCTFail("expected the runner idle once the tree XPC drained")
    }
  }

  /// A non-interactive query sweep runs its queries on the main thread one at a time. It must stop
  /// starting them at the slice deadline its caller waits for, not at the plan deadline, or it holds
  /// the main thread after the plan has answered (#2783).
  func testNonInteractiveQuerySweepStopsAtTheSliceItsCallerWaitsFor() throws {
    let sweepQueryCount = 19
    XCTAssertLessThan(RunnerSlowSweepQueryGate.queryDuration, Self.flatInteractiveQueryBudget)
    XCTAssertGreaterThan(
      RunnerSlowSweepQueryGate.queryDuration * Double(sweepQueryCount),
      Self.flatInteractiveFallbackBudget
    )
    guard
      let queryMethod = class_getInstanceMethod(
        XCUIElementQuery.self,
        #selector(getter: XCUIElementQuery.allElementsBoundByIndex)
      ),
      let stubMethod = class_getInstanceMethod(
        RunnerSlowSweepQueryStub.self,
        #selector(getter: RunnerSlowSweepQueryStub.allElementsBoundByIndex)
      )
    else {
      XCTFail("unable to install the slow sweep query stub")
      return
    }
    app.launchArguments = ["--agent-device-selector-read-regression"]
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    XCTAssertFalse(app.frame.isEmpty)
    let captureTarget = MainActor.assumeIsolated {
      mainOwned.app = app
      mainOwned.bundleId = "com.callstack.agentdevice.runner.query-sweep-slice-test"
      return takeSnapshotCaptureTarget(app: app)
    }
    RunnerSlowSweepQueryGate.reset()
    let originalImplementation = method_getImplementation(queryMethod)
    method_setImplementation(queryMethod, method_getImplementation(stubMethod))
    defer {
      method_setImplementation(queryMethod, originalImplementation)
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      MainActor.assumeIsolated {
        invalidateCachedTarget(reason: "unit_test_cleanup")
      }
      app.terminate()
    }

    final class ResultBox {
      var payload: DataPayload?
      var error: Error?
      var returnedAt: Date?
      var abandonedAtReturn: Bool?
    }
    let box = ResultBox()
    let planned = expectation(description: "query-sweep plan answered")
    DispatchQueue(label: "agent-device.runner.tests.query-sweep-slice").async {
      do {
        box.payload = try self.runSnapshotCapturePlan(
          [.querySweep],
          target: captureTarget,
          options: PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false),
          terminal: .sparseWithFatalOnAXFailure,
          deadline: Date().addingTimeInterval(20)
        )
      } catch {
        box.error = error
      }
      box.returnedAt = Date()
      box.abandonedAtReturn = self.hasAbandonedMainThreadWork()
      planned.fulfill()
    }

    wait(for: [planned], timeout: 30)
    let drainDeadline = Date().addingTimeInterval(3)
    while hasAbandonedMainThreadWork(), Date() < drainDeadline {
      sleepFor(0.005)
    }
    let starts = RunnerSlowSweepQueryGate.recordedStarts()

    XCTAssertNil(box.error)
    XCTAssertEqual(box.payload?.snapshotQuality?.backend, SnapshotBackendKind.querySweep.rawValue)
    XCTAssertEqual(
      box.abandonedAtReturn,
      false,
      "the sweep must finish inside the slice its caller waits for"
    )
    let returnedAt = try XCTUnwrap(box.returnedAt)
    XCTAssertTrue(
      starts.allSatisfy { $0 <= returnedAt },
      "no sweep query may start after the plan answered"
    )
    XCTAssertLessThan(starts.count, sweepQueryCount, "the slice must cut the sweep short")
    XCTAssertFalse(hasAbandonedMainThreadWork())
  }

  /// A query sweep that stops at its own slice deadline collected a partial tree, not an answer, so
  /// it is a tier timeout: the plan must arm the XCTest-channel penalty and let private AX answer,
  /// keeping the partial sweep only as the fallback. Accepting it because it carries more nodes than
  /// the sparse threshold ships a hierarchy-free capture and leaves every later capture of the same
  /// screen to pay for the full sweep again (#2781).
  func testQuerySweepThatEndsOnItsSliceDeadlinePenalizesChannelAndReachesPrivateAX() throws {
    guard
      let queryMethod = class_getInstanceMethod(
        XCUIElementQuery.self,
        #selector(getter: XCUIElementQuery.allElementsBoundByIndex)
      ),
      let stubMethod = class_getInstanceMethod(
        RunnerSlowSweepQueryStub.self,
        #selector(getter: RunnerSlowSweepQueryStub.allElementsBoundByIndex)
      )
    else {
      XCTFail("unable to install the slow sweep query stub")
      return
    }
    app.launchArguments = ["--agent-device-selector-read-regression"]
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    MainActor.assumeIsolated {
      mainOwned.app = app
      mainOwned.bundleId = "com.callstack.agentdevice.runner.query-sweep-timeout-test"
    }
    snapshotXCTestPenaltyWarmupExemption.isPending = false
    clearSnapshotXCTestChannelPenalty(reason: "test-setup")
    RunnerSlowSweepQueryGate.reset()
    let captureTarget = MainActor.assumeIsolated { takeSnapshotCaptureTarget(app: app) }
    let originalImplementation = method_getImplementation(queryMethod)
    method_setImplementation(queryMethod, method_getImplementation(stubMethod))
    defer {
      method_setImplementation(queryMethod, originalImplementation)
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      clearPrivateAXAcceptedDepth(reason: "test-cleanup")
      MainActor.assumeIsolated {
        invalidateCachedTarget(reason: "unit_test_cleanup")
      }
      app.terminate()
    }

    final class ResultBox {
      var payload: DataPayload?
      var error: Error?
      var abandonedAtReturn = false
      var penalizedAtReturn = false
      var sweepStartsAfterFirstPlan = 0
      var secondPayload: DataPayload?
      var secondError: Error?
    }
    let box = ResultBox()
    let planned = expectation(description: "slow-sweep plan answered")
    DispatchQueue(label: "agent-device.runner.tests.query-sweep-timeout").async {
      do {
        box.payload = try self.runSnapshotCapturePlan(
          [.querySweep, .privateAX],
          target: captureTarget,
          options: PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false),
          terminal: .sparseWithFatalOnAXFailure,
          deadline: Date().addingTimeInterval(20)
        )
      } catch {
        box.error = error
      }
      box.abandonedAtReturn = self.hasAbandonedMainThreadWork()
      box.penalizedAtReturn = self.isSnapshotXCTestChannelPenalized(bundleId: captureTarget.bundleId)
      box.sweepStartsAfterFirstPlan = RunnerSlowSweepQueryGate.recordedStarts().count
      do {
        box.secondPayload = try self.runSnapshotCapturePlan(
          Self.regularVisiblePlan,
          target: captureTarget,
          options: PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false),
          terminal: .sparseWithFatalOnAXFailure,
          deadline: Date().addingTimeInterval(20)
        )
      } catch {
        box.secondError = error
      }
      planned.fulfill()
    }

    wait(for: [planned], timeout: 60)
    XCTAssertNil(box.error)
    let quality = box.payload?.snapshotQuality
    XCTAssertEqual(
      quality?.backend,
      SnapshotBackendKind.privateAX.rawValue,
      "a sweep that ended on its slice deadline is a tier timeout, not an accepted capture"
    )
    XCTAssertEqual(quality?.state, .recovered)
    XCTAssertGreaterThan(box.payload?.nodes?.count ?? 0, 1, "private AX answers with a real tree")
    XCTAssertFalse(box.abandonedAtReturn, "the sweep must answer inside its own main-thread hop")
    XCTAssertTrue(
      box.penalizedAtReturn,
      "the tier timeout must arm the XCTest-channel penalty for the captured target"
    )

    XCTAssertNil(box.secondError)
    XCTAssertEqual(
      box.secondPayload?.snapshotQuality?.backend,
      SnapshotBackendKind.privateAX.rawValue,
      "the armed penalty must defer the next plan's XCTest tiers, not re-run the sweep"
    )
    XCTAssertEqual(
      RunnerSlowSweepQueryGate.recordedStarts().count,
      box.sweepStartsAfterFirstPlan,
      "the deferred plan may start no sweep query at all"
    )
    XCTAssertFalse(hasAbandonedMainThreadWork())
  }
}
#endif
