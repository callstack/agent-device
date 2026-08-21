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
  private let now: () -> Date
  private var acquisitionSeconds: TimeInterval = 0
  private var presentationSeconds: TimeInterval = 0

  init(now: @escaping () -> Date = { Date() }) {
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
  }

  /// The penalty breaker observes only acquisition facts. Presentation is a separate phase and
  /// cannot arm the breaker, even when it is slower than the acquisition that produced the tree.
  private static func snapshotXCTestPenaltyReason(
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
    guard attempt.timing.acquisitionMs > slowThresholdMs else { return nil }
    return "slow_\(kind.rawValue)_capture_\(Int(attempt.timing.acquisitionMs))ms"
  }

  func recordXCTestSnapshotBackendAttemptIfNeeded(
    _ kind: SnapshotBackendKind,
    attempt: SnapshotBackendAttempt,
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
      bundleId: currentBundleId,
      reason: reason
    )
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testXCTestPenaltyDecisionSeparatesAcquisitionAndPresentation() {
    let slowPresentation = SnapshotBackendAttempt(
      outcome: .noCapture,
      timing: SnapshotCaptureTiming(acquisitionMs: 100, presentationMs: 4_000)
    )
    XCTAssertNil(
      Self.snapshotXCTestPenaltyReason(
        kind: .recursiveTree,
        attempt: slowPresentation,
        slowThresholdMs: 3_000
      )
    )

    let slowAcquisition = SnapshotBackendAttempt(
      outcome: .noCapture,
      timing: SnapshotCaptureTiming(acquisitionMs: 3_001, presentationMs: 100)
    )
    XCTAssertEqual(
      Self.snapshotXCTestPenaltyReason(
        kind: .recursiveTree,
        attempt: slowAcquisition,
        slowThresholdMs: 3_000
      ),
      "slow_tree_capture_3001ms"
    )

    let timeout = SnapshotCaptureFailure(
      code: Self.xCTestSnapshotTimeoutCode,
      message: "test timeout",
      hint: "test"
    )
    let acquisitionFailure = SnapshotBackendAttempt(
      outcome: .failed(timeout, phase: .acquisition),
      timing: SnapshotCaptureTiming(acquisitionMs: 100, presentationMs: 100)
    )
    XCTAssertEqual(
      Self.snapshotXCTestPenaltyReason(
        kind: .recursiveTree,
        attempt: acquisitionFailure,
        slowThresholdMs: 3_000
      ),
      "tree_backend_timeout"
    )

    let presentationFailure = SnapshotBackendAttempt(
      outcome: .failed(timeout, phase: .presentation),
      timing: SnapshotCaptureTiming(acquisitionMs: 100, presentationMs: 100)
    )
    XCTAssertNil(
      Self.snapshotXCTestPenaltyReason(
        kind: .recursiveTree,
        attempt: presentationFailure,
        slowThresholdMs: 3_000
      )
    )
  }

  func testSnapshotPhaseTimerReportsAcquisitionAndPresentationSeparately() {
    var now = Date(timeIntervalSinceReferenceDate: 100)
    var timer = SnapshotPhaseTimer(now: { now })

    _ = timer.measure(.acquisition) {
      now = now.addingTimeInterval(2)
    }
    _ = timer.measure(.presentation) {
      now = now.addingTimeInterval(5)
    }

    XCTAssertEqual(timer.timing.acquisitionMs, 2_000, accuracy: 0.001)
    XCTAssertEqual(timer.timing.presentationMs, 5_000, accuracy: 0.001)
  }
}
#endif
