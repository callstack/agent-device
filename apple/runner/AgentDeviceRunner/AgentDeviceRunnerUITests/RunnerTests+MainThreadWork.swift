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
  private final class MainThreadWorkState<T> {
    let completed = DispatchSemaphore(value: 0)
    var result: Result<T, Error>?
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
    timeoutError: @escaping @Sendable () -> Error,
    onAbandoned: (@Sendable () -> Void)? = nil,
    _ work: @escaping @MainActor () throws -> T
  ) throws -> T {
    if Thread.isMainThread {
      return try runOnMainActor(work).get()
    }
    mainThreadWorkLock.lock()
    let state = enqueueMainThreadWorkLocked(operation, work)
    mainThreadWorkLock.unlock()
    return try awaitMainThreadWork(
      state,
      operation: operation,
      timeout: timeout,
      timeoutError: timeoutError,
      onAbandoned: onAbandoned
    )
  }

  /// Runs optional `work` like `runMainThreadWork`, but only while no other dispatched main-thread
  /// work is in flight; otherwise it returns `nil` without dispatching. The check and the enqueue
  /// happen under one hold of `mainThreadWorkLock`, the same lock every dispatch enqueues under, so
  /// admitted work never waits in the main queue behind a command's hop. The in-flight count covers
  /// abandoned work too: a block stays counted until it returns, and it marks itself abandoned in
  /// the same window, so occupancy that outlived its slice is already declined here.
  func runMainThreadWorkIfIdle<T>(
    _ operation: String,
    timeout: TimeInterval,
    timeoutError: @escaping @Sendable () -> Error,
    _ work: @escaping @MainActor () throws -> T
  ) throws -> T? {
    if Thread.isMainThread {
      return nil
    }
    mainThreadWorkLock.lock()
    guard mainThreadWorkInFlightCount == 0 else {
      mainThreadWorkLock.unlock()
      return nil
    }
    let state = enqueueMainThreadWorkLocked(operation, work)
    mainThreadWorkLock.unlock()
    return try awaitMainThreadWork(
      state,
      operation: operation,
      timeout: timeout,
      timeoutError: timeoutError,
      onAbandoned: nil
    )
  }

  private func enqueueMainThreadWorkLocked<T>(
    _ operation: String,
    _ work: @escaping @MainActor () throws -> T
  ) -> MainThreadWorkState<T> {
    let state = MainThreadWorkState<T>()
    mainThreadWorkInFlightCount += 1
    DispatchQueue.main.async {
      state.result = runOnMainActor(work)
      self.mainThreadWorkLock.lock()
      self.mainThreadWorkInFlightCount -= 1
      let abandoned = state.abandoned
      if abandoned {
        self.abandonedMainThreadWorkCount -= 1
        if self.abandonedMainThreadWorkCount == 0 {
          self.abandonedMainThreadWorkSince = nil
        }
      } else {
        state.finished = true
      }
      let allDrained = abandoned && self.abandonedMainThreadWorkCount == 0
      self.mainThreadWorkLock.unlock()
      if abandoned {
        NSLog("AGENT_DEVICE_RUNNER_MAIN_THREAD_WORK_DRAINED operation=%@", operation)
        if allDrained {
          NSLog("AGENT_DEVICE_RUNNER_ABANDONED_WORK_DRAINED")
        }
      }
      state.completed.signal()
    }
    return state
  }

  private func awaitMainThreadWork<T>(
    _ state: MainThreadWorkState<T>,
    operation: String,
    timeout: TimeInterval,
    timeoutError: @escaping @Sendable () -> Error,
    onAbandoned: (@Sendable () -> Void)?
  ) throws -> T {
    let waitResult = state.completed.wait(timeout: .now() + timeout)
    if waitResult == .timedOut {
      #if AGENT_DEVICE_RUNNER_UNIT_TESTS
      mainThreadWorkTimedOutForTesting?()
      #endif
      // Work that finished before the lock was taken already stored its result: it is answered
      // like work that finished in time, so an action that happened is never reported as a timeout.
      mainThreadWorkLock.lock()
      let abandoned = !state.finished
      if abandoned {
        state.abandoned = true
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
        throw timeoutError()
      }
    }
    switch state.result {
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

  static func mainThreadExecutionTimeoutError() -> Error {
    NSError(
      domain: RunnerErrorDomain.general,
      code: RunnerErrorCode.mainThreadExecutionTimedOut,
      userInfo: [NSLocalizedDescriptionKey: "main thread execution timed out"]
    )
  }
}
