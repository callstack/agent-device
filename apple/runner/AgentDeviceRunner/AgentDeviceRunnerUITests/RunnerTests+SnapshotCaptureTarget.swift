import XCTest

// MARK: - Snapshot capture target (#2781)
//
// Target identity (`currentApp`, `currentBundleId`, `currentAppProcessIdentifier`) and
// `runnerAccessibilityHealth` are owned by main-thread lifecycle code. A capture plan runs on the
// command queue, so it reads the identity from a `SnapshotCaptureTarget` taken on main while the
// command is prepared, and writes health or invalidates the target only through
// `applyMainOwnedSnapshotState`.

/// The target one capture plan reads, taken once on the main thread.
struct SnapshotCaptureTarget {
  let app: XCUIApplication
  let bundleId: String?
  let processIdentifier: Int?
}

/// What snapshot command preparation hands the off-main capture.
enum SnapshotCommandPreparation {
  case response(Response)
  case capture(SnapshotCaptureTarget, systemSurface: SystemSurfaceHost?)
}

extension RunnerTests {
  /// Main thread only: reads the lifecycle-owned target identity.
  func takeSnapshotCaptureTarget(app: XCUIApplication) -> SnapshotCaptureTarget {
    SnapshotCaptureTarget(
      app: app,
      bundleId: currentBundleId,
      processIdentifier: currentAppProcessIdentifier
    )
  }

  /// Runs `write` against main-owned runner state for a capture that may be on the command queue.
  /// Abandoned work ahead of the hop cannot be cancelled, so behind it the write queues without
  /// waiting: the capture answers now and the next command still observes the write.
  func applyMainOwnedSnapshotState(_ operation: String, _ write: @escaping () -> Void) {
    if Thread.isMainThread {
      write()
      return
    }
    guard !hasAbandonedMainThreadWork() else {
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_STATE_DEFERRED_XCTEST_OCCUPIED operation=%@", operation)
      DispatchQueue.main.async(execute: write)
      return
    }
    do {
      try runMainThreadWork(
        operation,
        timeout: 1,
        timeoutError: mainThreadExecutionTimeoutError,
        write
      )
    } catch {
      NSLog(
        "AGENT_DEVICE_RUNNER_SNAPSHOT_STATE_FAILED operation=%@ error=%@",
        operation,
        String(describing: error)
      )
    }
  }
}
