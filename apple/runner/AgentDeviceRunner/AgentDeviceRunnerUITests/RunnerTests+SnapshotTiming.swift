import Foundation
import XCTest

struct SnapshotCaptureTiming: Codable, Equatable {
  let acquisitionMs: Double
  let presentationMs: Double

  init(acquisitionMs: Double, presentationMs: Double) {
    self.acquisitionMs = max(0, acquisitionMs)
    self.presentationMs = max(0, presentationMs)
  }

  init(acquisition: TimeInterval, presentation: TimeInterval) {
    self.init(
      acquisitionMs: max(0, acquisition) * 1_000,
      presentationMs: max(0, presentation) * 1_000
    )
  }
}

enum SnapshotCapturePhase: Equatable {
  case acquisition
  case presentation
}

struct SnapshotPhaseTimer {
  private let now: @Sendable () -> Date
  private var acquisitionSeconds: TimeInterval = 0
  private var presentationSeconds: TimeInterval = 0

  init(now: @escaping @Sendable () -> Date = { Date() }) {
    self.now = now
  }

  mutating func measure<T>(
    _ phase: SnapshotCapturePhase,
    _ operation: () throws -> T
  ) rethrows -> T {
    let startedAt = now()
    defer {
      let elapsed = max(0, now().timeIntervalSince(startedAt))
      switch phase {
      case .acquisition:
        acquisitionSeconds += elapsed
      case .presentation:
        presentationSeconds += elapsed
      }
    }
    return try operation()
  }

  var timing: SnapshotCaptureTiming {
    SnapshotCaptureTiming(
      acquisition: acquisitionSeconds,
      presentation: presentationSeconds
    )
  }
}

/// Keeps the first capture plan that runs against a fresh target process from penalizing the XCTest
/// channel for a slow tier. Lifecycle code arms and disarms it on main; the capture plan consumes it
/// on the command queue, so a snapshot that returns before running a plan leaves it pending.
final class SnapshotXCTestPenaltyWarmupExemption {
  private let lock = NSLock()
  private var pending = false

  var isPending: Bool {
    get {
      lock.lock()
      defer { lock.unlock() }
      return pending
    }
    set {
      lock.lock()
      pending = newValue
      lock.unlock()
    }
  }

  func consume() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let wasPending = pending
    pending = false
    return wasPending
  }
}

extension RunnerTests {
  struct SnapshotBackendAttempt {
    enum Outcome {
      case noCapture
      case captured(SnapshotBackendCapture)
      case failed(SnapshotCaptureFailure, phase: SnapshotCapturePhase)
    }

    /// The failure phase is part of the result, so penalty policy cannot infer it from duration
    /// or error text.
    let outcome: Outcome
    let timing: SnapshotCaptureTiming
    /// Whether the tier finished collecting or stopped at its own deadline. A tier that stopped at
    /// its deadline timed out even when it handed back a payload, so penalty and recovery policy
    /// read this instead of classifying the payload (#2781).
    let tierOutcome: SnapshotTierOutcome

    init(
      outcome: Outcome,
      timing: SnapshotCaptureTiming,
      tierOutcome: SnapshotTierOutcome = .completed
    ) {
      self.outcome = outcome
      self.timing = timing
      self.tierOutcome = tierOutcome
    }
  }

  /// The penalty breaker observes only acquisition facts. Presentation is a separate phase and
  /// cannot arm the breaker, even when it is slower than the acquisition that produced the tree.
  static func snapshotXCTestPenaltyReason(
    kind: SnapshotBackendKind,
    attempt: SnapshotBackendAttempt,
    slowThresholdMs: Double
  ) -> String? {
    guard kind.usesXCTestAccessibilityChannel else { return nil }
    if case let .failed(failure, phase: .acquisition) = attempt.outcome,
      failure.code == Self.xCTestSnapshotTimeoutCode
    {
      return "\(kind.rawValue)_backend_timeout"
    }
    if attempt.tierOutcome == .deadlineExhausted {
      return "\(kind.rawValue)_backend_timeout"
    }
    guard attempt.timing.acquisitionMs > slowThresholdMs else { return nil }
    return "slow_\(kind.rawValue)_capture_\(Int(attempt.timing.acquisitionMs))ms"
  }

  func recordXCTestSnapshotBackendAttemptIfNeeded(
    _ kind: SnapshotBackendKind,
    attempt: SnapshotBackendAttempt,
    bundleId: String?,
    penaltySuppressed: Bool
  ) {
    guard !penaltySuppressed else { return }
    guard
      let reason = Self.snapshotXCTestPenaltyReason(
        kind: kind,
        attempt: attempt,
        slowThresholdMs: snapshotXCTestSlowCaptureThreshold * 1_000
      )
    else { return }
    penalizeSnapshotXCTestChannel(
      bundleId: bundleId,
      reason: reason
    )
  }
}
