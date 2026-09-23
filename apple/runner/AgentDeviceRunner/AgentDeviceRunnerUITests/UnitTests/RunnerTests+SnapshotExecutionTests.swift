import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testPostSnapshotDelayMarkDoesNotQueueBehindAbandonedMainThreadWork() {
    abandonedMainThreadWorkCount = 1
    defer {
      abandonedMainThreadWorkCount = 0
      needsPostSnapshotInteractionDelay = false
    }

    let finished = expectation(description: "off-main caller finished")
    DispatchQueue(label: "agent-device.runner.tests.post-snapshot-delay").async {
      self.setNeedsPostSnapshotInteractionDelay()
      finished.fulfill()
    }

    wait(for: [finished], timeout: 1)
    mainThreadWorkLock.lock()
    let abandonedWorkCount = abandonedMainThreadWorkCount
    mainThreadWorkLock.unlock()
    XCTAssertEqual(abandonedWorkCount, 1, "the skipped mark must not add an abandoned unit")
    XCTAssertFalse(needsPostSnapshotInteractionDelay)
  }

  func testSnapshotFailureInvalidationQueuesBehindAbandonedMainThreadWorkWithoutWaiting() {
    currentBundleId = "com.example.stale-target"
    defer { currentBundleId = nil }

    final class ResultBox {
      var elapsed: TimeInterval?
      var bundleStillCachedWhileBlocked: Bool?
      var abandonedWhileBlocked: Int?
    }
    let box = ResultBox()
    let mainBlocked = DispatchSemaphore(value: 0)
    let releaseMain = DispatchSemaphore(value: 0)
    let finished = expectation(description: "invalidation returned while main was blocked")

    DispatchQueue(label: "agent-device.runner.tests.snapshot-invalidation").async {
      _ = try? self.runMainThreadWork(
        "command_execution",
        timeout: 0,
        timeoutError: self.mainThreadExecutionTimeoutError
      ) {
        mainBlocked.signal()
        _ = releaseMain.wait(timeout: .now() + 5)
        return true
      }
      _ = mainBlocked.wait(timeout: .now() + 2)
      let startedAt = Date()
      self.invalidateCachedTargetAfterSnapshotFailure()
      box.elapsed = Date().timeIntervalSince(startedAt)
      box.bundleStillCachedWhileBlocked = self.currentBundleId != nil
      self.mainThreadWorkLock.lock()
      box.abandonedWhileBlocked = self.abandonedMainThreadWorkCount
      self.mainThreadWorkLock.unlock()
      releaseMain.signal()
      finished.fulfill()
    }

    wait(for: [finished], timeout: 8)
    let drainDeadline = Date().addingTimeInterval(2)
    while hasAbandonedMainThreadWork() || currentBundleId != nil, Date() < drainDeadline {
      sleepFor(0.005)
    }

    XCTAssertLessThan(
      box.elapsed ?? .infinity,
      0.5,
      "the failed capture must not wait behind abandoned main-thread work"
    )
    XCTAssertEqual(
      box.bundleStillCachedWhileBlocked,
      true,
      "the drop must queue behind the blocked main thread, not run early"
    )
    XCTAssertEqual(box.abandonedWhileBlocked, 1, "the deferred drop must not add an abandoned unit")
    XCTAssertFalse(hasAbandonedMainThreadWork())
    XCTAssertNil(currentBundleId, "the drop must run once the main thread frees")
  }
}
#endif
