import XCTest

// MARK: - Main-thread work

extension RunnerTests {
  /// Tracks one main-queue dispatch so the watchdog and the dispatched block can agree —
  /// under `mainThreadWorkLock` — on exactly one of: finished in time, or abandoned.
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

  func runMainThreadWork<T>(
    timeout: TimeInterval,
    timeoutError: @escaping () -> Error,
    onAbandoned: (() -> Void)? = nil,
    onDrained: (() -> Void)? = nil,
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
      if workState.abandoned {
        self.abandonedMainThreadWorkCount -= 1
        if self.abandonedMainThreadWorkCount == 0 {
          self.abandonedMainThreadWorkSince = nil
          NSLog("AGENT_DEVICE_RUNNER_ABANDONED_WORK_DRAINED")
        }
        self.mainThreadWorkLock.unlock()
        onDrained?()
      } else {
        workState.finished = true
        self.mainThreadWorkLock.unlock()
      }
      semaphore.signal()
    }
    let waitResult = semaphore.wait(timeout: .now() + timeout)
    if waitResult == .timedOut {
      mainThreadWorkLock.lock()
      let stillRunning = !workState.finished
      if stillRunning {
        workState.abandoned = true
        abandonedMainThreadWorkCount += 1
        if abandonedMainThreadWorkSince == nil {
          abandonedMainThreadWorkSince = Date()
        }
        onAbandoned?()
      }
      mainThreadWorkLock.unlock()
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
      var drainedCount: Int?
      var drainedSinceCleared: Bool?
    }
    let box = ResultBox()
    let releaseWork = DispatchSemaphore(value: 0)
    let observedAbandoned = DispatchSemaphore(value: 0)
    let finished = expectation(description: "off-main caller timed out")
    let drained = expectation(description: "abandoned main work drained")

    DispatchQueue(label: "agent-device.runner.tests.timeout").async {
      do {
        _ = try self.runMainThreadWork(
          timeout: 0,
          timeoutError: self.mainThreadExecutionTimeoutError,
          onAbandoned: {
            box.abandonedCount = self.abandonedMainThreadWorkCount
            box.abandonedSinceSet = self.abandonedMainThreadWorkSince != nil
            observedAbandoned.signal()
          },
          onDrained: {
            self.mainThreadWorkLock.lock()
            box.drainedCount = self.abandonedMainThreadWorkCount
            box.drainedSinceCleared = self.abandonedMainThreadWorkSince == nil
            self.mainThreadWorkLock.unlock()
            drained.fulfill()
          }
        ) {
          _ = releaseWork.wait(timeout: .now() + 1)
          return true
        }
      } catch {
        box.error = error
      }
      finished.fulfill()
    }

    DispatchQueue(label: "agent-device.runner.tests.release-timeout").async {
      _ = observedAbandoned.wait(timeout: .now() + 1)
      releaseWork.signal()
    }

    wait(for: [finished, drained], timeout: 2)
    XCTAssertEqual((box.error as NSError?)?.code, RunnerErrorCode.mainThreadExecutionTimedOut)
    XCTAssertEqual(box.abandonedCount, 1)
    XCTAssertEqual(box.abandonedSinceSet, true)
    XCTAssertEqual(box.drainedCount, 0)
    XCTAssertEqual(box.drainedSinceCleared, true)
  }
}
#endif
