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
