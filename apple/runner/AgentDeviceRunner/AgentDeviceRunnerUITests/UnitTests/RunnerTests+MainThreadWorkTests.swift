import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testRunMainThreadWorkExecutesOffMainCallerOnMainThread() {
    final class ResultBox {
      var observedMainThread: Bool?
      var error: Error?
    }
    let box = ResultBox()
    let finished = expectation(description: "off-main caller finished")

    DispatchQueue(label: "agent-device.runner.tests.off-main").async {
      do {
        box.observedMainThread = try self.runMainThreadWork(
          "command_execution",
          timeout: 1,
          timeoutError: self.mainThreadExecutionTimeoutError
        ) {
          Thread.isMainThread
        }
      } catch {
        box.error = error
      }
      finished.fulfill()
    }

    wait(for: [finished], timeout: 2)
    XCTAssertNil(box.error)
    XCTAssertEqual(box.observedMainThread, true)
  }

  func testRunMainThreadWorkTimeoutMarksAbandonedUntilDrained() {
    final class ResultBox {
      var error: Error?
      var abandonedCount: Int?
      var abandonedSinceSet: Bool?
      var busyWhileAbandoned = false
    }
    let box = ResultBox()
    let releaseWork = DispatchSemaphore(value: 0)
    let observedAbandoned = DispatchSemaphore(value: 0)
    let timedOut = expectation(description: "off-main caller timed out")

    DispatchQueue(label: "agent-device.runner.tests.timeout").async {
      do {
        _ = try self.runMainThreadWork(
          "command_execution",
          timeout: 0,
          timeoutError: self.mainThreadExecutionTimeoutError
        ) {
          _ = releaseWork.wait(timeout: .now() + 2)
          return true
        }
      } catch {
        box.error = error
      }
      self.mainThreadWorkLock.lock()
      box.abandonedCount = self.abandonedMainThreadWorkCount
      box.abandonedSinceSet = self.abandonedMainThreadWorkSince != nil
      self.mainThreadWorkLock.unlock()
      if case .busy = self.currentMainThreadBusyState() {
        box.busyWhileAbandoned = true
      }
      observedAbandoned.signal()
      timedOut.fulfill()
    }
    DispatchQueue(label: "agent-device.runner.tests.release-timeout").async {
      _ = observedAbandoned.wait(timeout: .now() + 2)
      releaseWork.signal()
    }

    wait(for: [timedOut], timeout: 3)
    let drainDeadline = Date().addingTimeInterval(2)
    while hasAbandonedMainThreadWork(), Date() < drainDeadline {
      sleepFor(0.005)
    }

    XCTAssertEqual((box.error as NSError?)?.code, RunnerErrorCode.mainThreadExecutionTimedOut)
    XCTAssertEqual(box.abandonedCount, 1)
    XCTAssertEqual(box.abandonedSinceSet, true)
    XCTAssertTrue(box.busyWhileAbandoned)
    XCTAssertFalse(hasAbandonedMainThreadWork(), "drained work must release the main thread")
    mainThreadWorkLock.lock()
    let sinceCleared = abandonedMainThreadWorkSince == nil
    mainThreadWorkLock.unlock()
    XCTAssertTrue(sinceCleared)
    guard case .idle = currentMainThreadBusyState() else {
      return XCTFail("expected the runner idle once the abandoned work drained")
    }
  }
}
#endif
