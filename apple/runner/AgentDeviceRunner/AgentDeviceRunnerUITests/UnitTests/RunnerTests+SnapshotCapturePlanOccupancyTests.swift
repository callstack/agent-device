import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

/// Per-run gate for `RunnerBlockingSnapshotStub`: the swizzled IMP cannot capture a test-local
/// semaphore, and one shared across runs would carry leftover signals into the next run.
private enum RunnerBlockingSnapshotGate {
  static var release = DispatchSemaphore(value: 0)
}

/// Stands in for `-[XCUIElement snapshotWithError:]` so the tree tier's XPC grinds the way it does
/// on a live Bluesky feed: it blocks the main thread until the test releases it, then fails like a
/// read the AX server gave up on. The swap is process-wide while installed, which serial XCTest
/// execution tolerates.
private final class RunnerBlockingSnapshotStub: NSObject {
  @objc(snapshotWithError:)
  func snapshot() throws -> XCUIElementSnapshot {
    _ = RunnerBlockingSnapshotGate.release.wait(timeout: .now() + 20)
    throw NSError(
      domain: "AgentDeviceRunner.tests",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "blocked tree snapshot released"]
    )
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
    currentApp = app
    currentBundleId = "com.callstack.agentdevice.runner.tree-capture-test"
    snapshotXCTestPenaltyWarmupExemptionPending = true
    RunnerBlockingSnapshotGate.release = DispatchSemaphore(value: 0)
    let originalImplementation = method_getImplementation(snapshotMethod)
    method_setImplementation(snapshotMethod, method_getImplementation(stubMethod))
    defer {
      RunnerBlockingSnapshotGate.release.signal()
      method_setImplementation(snapshotMethod, originalImplementation)
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      clearPrivateAXAcceptedDepth(reason: "test-cleanup")
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }

    final class ResultBox {
      var payload: DataPayload?
      var error: Error?
      var abandonedAfterPlan: Int?
      var penalizedAfterPlan: Bool?
    }
    let box = ResultBox()
    let planned = expectation(description: "capture plan answered while the tree XPC grinds")
    DispatchQueue(label: "agent-device.runner.tests.plan-occupancy").async {
      do {
        box.payload = try self.runSnapshotCapturePlan(
          Self.regularVisiblePlan,
          app: self.app,
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
      box.penalizedAfterPlan = self.isSnapshotXCTestChannelPenalized(bundleId: self.currentBundleId)
      RunnerBlockingSnapshotGate.release.signal()
      planned.fulfill()
    }

    wait(for: [planned], timeout: 60)
    let drainDeadline = Date().addingTimeInterval(3)
    while hasAbandonedMainThreadWork(), Date() < drainDeadline {
      sleepFor(0.005)
    }

    XCTAssertNil(box.error)
    let quality = try XCTUnwrap(box.payload?.snapshotQuality)
    XCTAssertEqual(quality.backend, SnapshotBackendKind.privateAX.rawValue)
    XCTAssertEqual(quality.state, "recovered")
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
}
#endif
