import Foundation
import XCTest

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

  /// A tier that stopped starting work at its own deadline is a timeout for the breaker even when it
  /// answered fast and with a payload: the partial sweep must arm the penalty exactly as a slow tier
  /// does, and a tier that finished fast must not (#2781).
  func testDeadlineExhaustedTierAttemptArmsTheChannelPenaltyWithoutBeingSlow() {
    let capture = SnapshotBackendCapture(
      payload: DataPayload(nodes: [], truncated: true),
      effectiveDepth: nil
    )
    let exhausted = SnapshotBackendAttempt(
      outcome: .captured(capture),
      timing: SnapshotCaptureTiming(acquisitionMs: 1_000, presentationMs: 10),
      tierOutcome: .deadlineExhausted
    )
    XCTAssertEqual(
      Self.snapshotXCTestPenaltyReason(
        kind: .querySweep,
        attempt: exhausted,
        slowThresholdMs: 3_000
      ),
      "queries_backend_timeout"
    )

    let completed = SnapshotBackendAttempt(
      outcome: .captured(capture),
      timing: SnapshotCaptureTiming(acquisitionMs: 1_000, presentationMs: 10),
      tierOutcome: .completed
    )
    XCTAssertNil(
      Self.snapshotXCTestPenaltyReason(
        kind: .querySweep,
        attempt: completed,
        slowThresholdMs: 3_000
      )
    )

    XCTAssertNil(
      Self.snapshotXCTestPenaltyReason(
        kind: .privateAX,
        attempt: exhausted,
        slowThresholdMs: 3_000
      ),
      "a tier that owes nothing to the XCTest channel cannot penalize it"
    )
  }

  func testSnapshotPhaseTimerReportsAcquisitionAndPresentationSeparately() {
    final class Clock {
      var now = Date(timeIntervalSinceReferenceDate: 100)
    }
    let clock = Clock()
    var timer = SnapshotPhaseTimer(now: { clock.now })

    _ = timer.measure(.acquisition) {
      clock.now = clock.now.addingTimeInterval(2)
    }
    _ = timer.measure(.presentation) {
      clock.now = clock.now.addingTimeInterval(5)
    }

    XCTAssertEqual(timer.timing.acquisitionMs, 2_000, accuracy: 0.001)
    XCTAssertEqual(timer.timing.presentationMs, 5_000, accuracy: 0.001)
  }
}
#endif
