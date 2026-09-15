import XCTest

// MARK: - Bounded main-thread work (#1105/#1244)
//
// XCTest accessibility work (element snapshots, query resolution, `frame` reads) runs on the main
// thread through testmanagerd and cannot be cancelled. Every off-main caller dispatches it through
// `runMainThreadWork` under a slice; a block that outlives its slice is abandoned and counted until
// it drains. While any abandoned block is outstanding the main thread is occupied: new commands
// answer RUNNER_BUSY, capture plans skip XCTest-backed tiers, and post-capture bookkeeping stays
// off main instead of queueing behind work that cannot be cancelled.

extension RunnerTests {
  /// Tracks one main-queue dispatch so the watchdog and the dispatched block can agree, under
  /// `mainThreadWorkLock`, on exactly one of: finished in time, or abandoned.
  private final class MainThreadWorkState {
    var finished = false
    var abandoned = false
  }

  enum MainThreadBusyState {
    case idle
    case busy(abandonedForSeconds: TimeInterval)
    case wedged(abandonedForSeconds: TimeInterval)

    /// Whether the main thread is occupied by watchdog-abandoned work, for the occupancy stamp that
    /// every successful response carries. Wedged is still occupied: it only differs in that a
    /// restart, not waiting, is the cure.
    var reportsMainThreadBusy: Bool {
      if case .idle = self { return false }
      return true
    }
  }

  func currentMainThreadBusyState() -> MainThreadBusyState {
    mainThreadWorkLock.lock()
    defer { mainThreadWorkLock.unlock() }
    guard abandonedMainThreadWorkCount > 0 else { return .idle }
    let abandonedFor = abandonedMainThreadWorkSince.map { Date().timeIntervalSince($0) } ?? 0
    if abandonedFor > mainThreadWedgeThreshold {
      return .wedged(abandonedForSeconds: abandonedFor)
    }
    return .busy(abandonedForSeconds: abandonedFor)
  }

  func hasAbandonedMainThreadWork() -> Bool {
    mainThreadWorkLock.lock()
    defer { mainThreadWorkLock.unlock() }
    return abandonedMainThreadWorkCount > 0
  }

  /// Runs `work` on the main thread and waits at most `timeout` for it. On timeout the block
  /// keeps running on main (it cannot be cancelled), so it is counted as abandoned until it
  /// drains; `operation` names it in the abandoned/drained log markers, and `onAbandoned` runs
  /// once after that accounting, outside the lock, for operation-specific penalties.
  func runMainThreadWork<T>(
    _ operation: String,
    timeout: TimeInterval,
    timeoutError: @escaping () -> Error,
    onAbandoned: (() -> Void)? = nil,
    _ work: @escaping () throws -> T
  ) throws -> T {
    if Thread.isMainThread {
      return try work()
    }
    var result: Result<T, Error>?
    let semaphore = DispatchSemaphore(value: 0)
    let workState = MainThreadWorkState()
    DispatchQueue.main.async {
      do {
        result = .success(try work())
      } catch {
        result = .failure(error)
      }
      self.mainThreadWorkLock.lock()
      let abandoned = workState.abandoned
      if abandoned {
        self.abandonedMainThreadWorkCount -= 1
        if self.abandonedMainThreadWorkCount == 0 {
          self.abandonedMainThreadWorkSince = nil
        }
      } else {
        workState.finished = true
      }
      let allDrained = abandoned && self.abandonedMainThreadWorkCount == 0
      self.mainThreadWorkLock.unlock()
      if abandoned {
        NSLog("AGENT_DEVICE_RUNNER_MAIN_THREAD_WORK_DRAINED operation=%@", operation)
        if allDrained {
          NSLog("AGENT_DEVICE_RUNNER_ABANDONED_WORK_DRAINED")
        }
      }
      semaphore.signal()
    }
    let waitResult = semaphore.wait(timeout: .now() + timeout)
    if waitResult == .timedOut {
      mainThreadWorkLock.lock()
      let abandoned = !workState.finished
      if abandoned {
        workState.abandoned = true
        abandonedMainThreadWorkCount += 1
        if abandonedMainThreadWorkSince == nil {
          abandonedMainThreadWorkSince = Date()
        }
      }
      mainThreadWorkLock.unlock()
      if abandoned {
        NSLog(
          "AGENT_DEVICE_RUNNER_MAIN_THREAD_WORK_ABANDONED operation=%@ slice=%.1f",
          operation,
          timeout
        )
        onAbandoned?()
      }
      throw timeoutError()
    }
    switch result {
    case .success(let value):
      return value
    case .failure(let error):
      throw error
    case .none:
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.noResponseFromMainThread,
        userInfo: [NSLocalizedDescriptionKey: "no response from main thread"]
      )
    }
  }

  func mainThreadExecutionTimeoutError() -> Error {
    NSError(
      domain: RunnerErrorDomain.general,
      code: RunnerErrorCode.mainThreadExecutionTimedOut,
      userInfo: [NSLocalizedDescriptionKey: "main thread execution timed out"]
    )
  }
}

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
