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
  /// What one planned step did, recording the step that executed it. The step travels with the
  /// attempt, so penalty policy reads the authority the work ran under instead of a parameter a
  /// caller could omit or default (`RunnerTests+SnapshotChannelPolicy.swift`).
  struct SnapshotBackendAttempt {
    enum Outcome {
      case noCapture
      case captured(SnapshotBackendCapture)
      case failed(SnapshotCaptureFailure, phase: SnapshotCapturePhase)
    }

    let step: SnapshotCaptureStep
    /// The failure phase is part of the result, so penalty policy cannot infer it from duration
    /// or error text.
    let outcome: Outcome
    let timing: SnapshotCaptureTiming
    /// Whether the tier finished collecting or stopped at its own deadline. A tier that stopped at
    /// its deadline timed out even when it handed back a payload, so penalty and recovery policy
    /// read this instead of classifying the payload (#2781).
    let tierOutcome: SnapshotTierOutcome

    init(
      step: SnapshotCaptureStep,
      outcome: Outcome,
      timing: SnapshotCaptureTiming,
      tierOutcome: SnapshotTierOutcome = .completed
    ) {
      self.step = step
      self.outcome = outcome
      self.timing = timing
      self.tierOutcome = tierOutcome
    }
  }

  /// Records what one attempt shows about the XCTest channel, given the step that ran it. An
  /// ordinary attempt is the only one with an arming branch; a bounded recovery attempt can only
  /// clear the penalty by answering with an accepted fast tree. The warmup exemption suppresses
  /// arming on the first plan against a fresh process, never the early clear.
  func recordXCTestSnapshotBackendAttemptIfNeeded(
    attempt: SnapshotBackendAttempt,
    bundleId: String?,
    penaltySuppressed: Bool
  ) {
    guard !penaltySuppressed else { return }
    if Self.snapshotBoundedRecoveryRestoredChannel(attempt) {
      clearSnapshotXCTestChannelPenalty(reason: "healthy_tree_recovery_probe")
      return
    }
    guard
      let reason = Self.snapshotXCTestPenaltyReason(
        for: attempt,
        slowThresholdMs: snapshotXCTestSlowCaptureThreshold * 1_000
      )
    else { return }
    penalizeSnapshotXCTestChannel(
      bundleId: bundleId,
      reason: reason
    )
  }
}
