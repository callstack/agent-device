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
          timeoutError: Self.mainThreadExecutionTimeoutError
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
          timeoutError: Self.mainThreadExecutionTimeoutError
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

  func testRunMainThreadWorkReturnsWorkThatFinishedAtTheTimeoutBoundary() {
    let outcome = runMainThreadWorkFinishingAtTheTimeoutBoundary { 42 }

    XCTAssertNil(outcome.error, "work that finished before the lock must not read as a timeout")
    XCTAssertEqual(outcome.value, 42)
    XCTAssertEqual(outcome.abandonedCount, 0)
    XCTAssertEqual(outcome.onAbandonedCalls, 0)
  }

  func testRunMainThreadWorkRethrowsWorkThatFailedAtTheTimeoutBoundary() {
    let outcome = runMainThreadWorkFinishingAtTheTimeoutBoundary { () throws -> Int in
      throw NSError(domain: "agent-device.runner.tests", code: 7)
    }

    XCTAssertNil(outcome.value)
    XCTAssertEqual((outcome.error as NSError?)?.domain, "agent-device.runner.tests")
    XCTAssertEqual((outcome.error as NSError?)?.code, 7)
    XCTAssertEqual(outcome.abandonedCount, 0)
    XCTAssertEqual(outcome.onAbandonedCalls, 0)
  }

  func testRunMainThreadWorkIfIdleDeclinesWhileOtherWorkIsInFlight() {
    final class Outcome {
      var offeredWhileInFlight = false
      var whileInFlight: Bool?
      var ranWhileInFlight = false
      var whenIdle: Bool?
      var error: Error?
    }
    let outcome = Outcome()
    let releaseCommand = DispatchSemaphore(value: 0)
    let commandEntered = DispatchSemaphore(value: 0)
    let finished = expectation(description: "optional work was offered during and after the command")

    DispatchQueue(label: "agent-device.runner.tests.in-flight-command").async {
      _ = try? self.runMainThreadWork(
        "command_execution",
        timeout: 5,
        timeoutError: Self.mainThreadExecutionTimeoutError
      ) {
        commandEntered.signal()
        _ = releaseCommand.wait(timeout: .now() + 3)
      }
    }
    DispatchQueue(label: "agent-device.runner.tests.optional-work").async {
      defer { finished.fulfill() }
      guard commandEntered.wait(timeout: .now() + 3) == .success else { return }
      do {
        outcome.whileInFlight = try self.runMainThreadWorkIfIdle(
          "recording_frame",
          timeout: 5,
          timeoutError: Self.mainThreadExecutionTimeoutError
        ) { () -> Bool in
          outcome.ranWhileInFlight = true
          return true
        }
        outcome.offeredWhileInFlight = true
      } catch {
        outcome.error = error
      }
      releaseCommand.signal()
      let idleDeadline = Date().addingTimeInterval(3)
      while Date() < idleDeadline {
        self.mainThreadWorkLock.lock()
        let inFlight = self.mainThreadWorkInFlightCount
        self.mainThreadWorkLock.unlock()
        if inFlight == 0 { break }
        usleep(2_000)
      }
      do {
        outcome.whenIdle = try self.runMainThreadWorkIfIdle(
          "recording_frame",
          timeout: 5,
          timeoutError: Self.mainThreadExecutionTimeoutError
        ) {
          Thread.isMainThread
        }
      } catch {
        outcome.error = error
      }
    }

    wait(for: [finished], timeout: 10)
    XCTAssertNil(outcome.error)
    XCTAssertTrue(outcome.offeredWhileInFlight)
    XCTAssertNil(outcome.whileInFlight, "optional work declines while a hop is in flight")
    XCTAssertFalse(outcome.ranWhileInFlight, "declined work is never dispatched")
    XCTAssertEqual(outcome.whenIdle, true, "optional work runs on main once main is idle")
    XCTAssertFalse(hasAbandonedMainThreadWork())
  }

  func testRunMainThreadWorkIfIdleDeclinesAbandonedWorkUntilItDrains() {
    final class Outcome {
      var abandonedCount = 0
      var inFlightCount = 0
      var offeredWhileAbandoned = false
      var whileAbandoned: Bool?
      var ranWhileAbandoned = false
      var afterDrain: Bool?
      var error: Error?
    }
    let outcome = Outcome()
    let releaseWork = DispatchSemaphore(value: 0)
    let finished = expectation(description: "optional work was offered while abandoned and after drain")

    DispatchQueue(label: "agent-device.runner.tests.abandoned-then-drained").async {
      defer { finished.fulfill() }
      _ = try? self.runMainThreadWork(
        "command_execution",
        timeout: 0,
        timeoutError: Self.mainThreadExecutionTimeoutError
      ) {
        _ = releaseWork.wait(timeout: .now() + 3)
      }
      self.mainThreadWorkLock.lock()
      outcome.abandonedCount = self.abandonedMainThreadWorkCount
      outcome.inFlightCount = self.mainThreadWorkInFlightCount
      self.mainThreadWorkLock.unlock()
      do {
        outcome.whileAbandoned = try self.runMainThreadWorkIfIdle(
          "recording_frame",
          timeout: 5,
          timeoutError: Self.mainThreadExecutionTimeoutError
        ) { () -> Bool in
          outcome.ranWhileAbandoned = true
          return true
        }
        outcome.offeredWhileAbandoned = true
      } catch {
        outcome.error = error
      }
      releaseWork.signal()
      let drainDeadline = Date().addingTimeInterval(3)
      while self.hasAbandonedMainThreadWork(), Date() < drainDeadline {
        usleep(2_000)
      }
      do {
        outcome.afterDrain = try self.runMainThreadWorkIfIdle(
          "recording_frame",
          timeout: 5,
          timeoutError: Self.mainThreadExecutionTimeoutError
        ) {
          Thread.isMainThread
        }
      } catch {
        outcome.error = error
      }
    }

    wait(for: [finished], timeout: 10)
    XCTAssertNil(outcome.error)
    XCTAssertEqual(outcome.abandonedCount, 1)
    XCTAssertEqual(outcome.inFlightCount, 1, "abandoned work stays counted in flight until it returns")
    XCTAssertTrue(outcome.offeredWhileAbandoned)
    XCTAssertNil(outcome.whileAbandoned, "optional work declines while abandoned work holds main")
    XCTAssertFalse(outcome.ranWhileAbandoned, "declined work is never dispatched")
    XCTAssertEqual(outcome.afterDrain, true, "optional work runs on main once abandoned work drained")
    XCTAssertFalse(hasAbandonedMainThreadWork())
  }

  private final class BoundaryOutcome {
    var value: Int?
    var error: Error?
    var abandonedCount: Int?
    var onAbandonedCalls = 0
  }

  /// Times the wait out immediately, then lets the work finish before the watchdog takes the lock:
  /// the seam releases the blocked work and waits for the serial main queue to run past it.
  private func runMainThreadWorkFinishingAtTheTimeoutBoundary(
    _ produce: @escaping () throws -> Int
  ) -> BoundaryOutcome {
    let outcome = BoundaryOutcome()
    let releaseWork = DispatchSemaphore(value: 0)
    let finished = expectation(description: "off-main caller finished")
    mainThreadWorkTimedOutForTesting = {
      releaseWork.signal()
      DispatchQueue.main.sync {}
    }
    defer { mainThreadWorkTimedOutForTesting = nil }

    DispatchQueue(label: "agent-device.runner.tests.timeout-boundary").async {
      do {
        outcome.value = try self.runMainThreadWork(
          "command_execution",
          timeout: 0,
          timeoutError: Self.mainThreadExecutionTimeoutError,
          onAbandoned: { outcome.onAbandonedCalls += 1 }
        ) {
          _ = releaseWork.wait(timeout: .now() + 2)
          return try produce()
        }
      } catch {
        outcome.error = error
      }
      self.mainThreadWorkLock.lock()
      outcome.abandonedCount = self.abandonedMainThreadWorkCount
      self.mainThreadWorkLock.unlock()
      finished.fulfill()
    }

    wait(for: [finished], timeout: 3)
    return outcome
  }
}
#endif
