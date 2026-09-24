import XCTest

// MARK: - Snapshot capture target (#2781)
//
// Target identity and accessibility health live in `RunnerMainOwnedState`, owned by main-thread
// lifecycle code. A capture plan runs on the command queue, so it reads the identity from a
// `SnapshotCaptureTarget` taken on main while the command is prepared, and writes health or
// invalidates the target only through `applyMainOwnedSnapshotState`.

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

/// The target a bounded XCTest probe arms its abandonment penalty with.
///
/// The hook that arms the penalty fires on the command queue the moment the probe's slice is spent,
/// while the probe's own work block may still be running on main. `mainOwned.bundleId` belongs to
/// main, so it is never read across that boundary: a caller that already took the identity on main
/// hands it over, and a caller that is on the command queue lets the probe's main-side block capture
/// the identity main holds once the work actually starts (#2781).
enum SnapshotProbePenaltyTarget: Equatable {
  /// Identity a capture took on main when it prepared its target.
  case prepared(bundleId: String?)
  /// Read `mainOwned.bundleId` inside the probe's main-side block.
  case mainOwnedTarget
}

/// One probe's penalty identity: written by the probe's main-side block, read by the command queue's
/// abandonment hook through this lock.
final class SnapshotProbePenaltyIdentity {
  private let lock = NSLock()
  private var bundleId: String?
  private let readsMainOwnedTarget: Bool

  init(_ target: SnapshotProbePenaltyTarget) {
    readsMainOwnedTarget = target == .mainOwnedTarget
    if case .prepared(let bundleId) = target {
      self.bundleId = bundleId
    }
  }

  /// Called on the main thread inside the probe's work block, before it enumerates anything, so the
  /// identity is the one main had settled on rather than one a queued write is about to replace.
  func captureFromMain(bundleId: String?) {
    guard readsMainOwnedTarget else { return }
    lock.lock()
    self.bundleId = bundleId
    lock.unlock()
  }

  var penalizedBundleId: String? {
    lock.lock()
    defer { lock.unlock() }
    return bundleId
  }
}

extension RunnerTests {
  /// Reads the lifecycle-owned target identity.
  @MainActor
  func takeSnapshotCaptureTarget(app: XCUIApplication) -> SnapshotCaptureTarget {
    SnapshotCaptureTarget(
      app: app,
      bundleId: mainOwned.bundleId,
      processIdentifier: mainOwned.processIdentifier
    )
  }

  /// Runs `write` against main-owned runner state for a capture that may be on the command queue.
  /// Abandoned work ahead of the hop cannot be cancelled, so behind it the write queues without
  /// waiting: the capture answers now and the next command still observes the write.
  func applyMainOwnedSnapshotState(_ operation: String, _ write: @escaping @MainActor () -> Void) {
    if Thread.isMainThread {
      _ = runOnMainActor(write)
      return
    }
    guard !hasAbandonedMainThreadWork() else {
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_STATE_DEFERRED_XCTEST_OCCUPIED operation=%@", operation)
      DispatchQueue.main.async {
        _ = runOnMainActor(write)
      }
      return
    }
    do {
      try runMainThreadWork(
        operation,
        timeout: 1,
        timeoutError: Self.mainThreadExecutionTimeoutError,
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
