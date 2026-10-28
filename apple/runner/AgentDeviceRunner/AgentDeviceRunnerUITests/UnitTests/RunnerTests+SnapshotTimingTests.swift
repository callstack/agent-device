import Foundation
import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testXCTestPenaltyDecisionSeparatesAcquisitionAndPresentation() {
    let slowPresentation = SnapshotBackendAttempt(
      step: .ordinary(.recursiveTree),
      outcome: .noCapture,
      timing: SnapshotCaptureTiming(acquisitionMs: 100, presentationMs: 4_000)
    )
    XCTAssertNil(
      Self.snapshotXCTestPenaltyReason(
        for: slowPresentation,
        slowThresholdMs: 3_000
      )
    )

    let slowAcquisition = SnapshotBackendAttempt(
      step: .ordinary(.recursiveTree),
      outcome: .noCapture,
      timing: SnapshotCaptureTiming(acquisitionMs: 3_001, presentationMs: 100)
    )
    XCTAssertEqual(
      Self.snapshotXCTestPenaltyReason(
        for: slowAcquisition,
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
      step: .ordinary(.recursiveTree),
      outcome: .failed(timeout, phase: .acquisition),
      timing: SnapshotCaptureTiming(acquisitionMs: 100, presentationMs: 100)
    )
    XCTAssertEqual(
      Self.snapshotXCTestPenaltyReason(
        for: acquisitionFailure,
        slowThresholdMs: 3_000
      ),
      "tree_backend_timeout"
    )

    let presentationFailure = SnapshotBackendAttempt(
      step: .ordinary(.recursiveTree),
      outcome: .failed(timeout, phase: .presentation),
      timing: SnapshotCaptureTiming(acquisitionMs: 100, presentationMs: 100)
    )
    XCTAssertNil(
      Self.snapshotXCTestPenaltyReason(
        for: presentationFailure,
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
      step: .ordinary(.querySweep),
      outcome: .captured(capture),
      timing: SnapshotCaptureTiming(acquisitionMs: 1_000, presentationMs: 10),
      tierOutcome: .deadlineExhausted
    )
    XCTAssertEqual(
      Self.snapshotXCTestPenaltyReason(
        for: exhausted,
        slowThresholdMs: 3_000
      ),
      "queries_backend_timeout"
    )

    let completed = SnapshotBackendAttempt(
      step: .ordinary(.querySweep),
      outcome: .captured(capture),
      timing: SnapshotCaptureTiming(acquisitionMs: 1_000, presentationMs: 10),
      tierOutcome: .completed
    )
    XCTAssertNil(
      Self.snapshotXCTestPenaltyReason(
        for: completed,
        slowThresholdMs: 3_000
      )
    )

    let unownedExhausted = SnapshotBackendAttempt(
      step: .ordinary(.privateAX),
      outcome: exhausted.outcome,
      timing: exhausted.timing,
      tierOutcome: exhausted.tierOutcome
    )
    XCTAssertNil(
      Self.snapshotXCTestPenaltyReason(
        for: unownedExhausted,
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

  func testNormalPlanSweepTimeoutPenalizesRegardlessOfItsShortSlice() {
    let timeout = SnapshotCaptureFailure(
      code: Self.xCTestSnapshotTimeoutCode, message: "same timeout text", hint: "test"
    )
    for outcome in [SnapshotBackendAttempt.Outcome.failed(timeout, phase: .acquisition), .noCapture] {
      let short = { (kind: SnapshotBackendKind) in
        SnapshotBackendAttempt(
          step: .ordinary(kind),
          outcome: outcome,
          timing: SnapshotCaptureTiming(acquisitionMs: 1_000, presentationMs: 10),
          tierOutcome: .deadlineExhausted
        )
      }
      XCTAssertEqual(Self.snapshotXCTestPenaltyReason(
        for: short(.querySweep), slowThresholdMs: 3_000
      ), "queries_backend_timeout")
      XCTAssertEqual(Self.snapshotXCTestPenaltyReason(
        for: short(.recursiveTree), slowThresholdMs: 3_000
      ), "tree_backend_timeout")
      let slow = { (kind: SnapshotBackendKind) in
        SnapshotBackendAttempt(
          step: .ordinary(kind),
          outcome: outcome,
          timing: SnapshotCaptureTiming(acquisitionMs: 3_001, presentationMs: 10),
          tierOutcome: .deadlineExhausted
        )
      }
      XCTAssertEqual(Self.snapshotXCTestPenaltyReason(
        for: slow(.querySweep), slowThresholdMs: 3_000
      ), "queries_backend_timeout")
    }
    let untyped = SnapshotBackendAttempt(
      step: .ordinary(.recursiveTree),
      outcome: .failed(SnapshotCaptureFailure(
        code: "OTHER_FAILURE", message: "same timeout text", hint: "test"
      ), phase: .acquisition),
      timing: SnapshotCaptureTiming(acquisitionMs: 100, presentationMs: 0)
    )
    XCTAssertNil(Self.snapshotXCTestPenaltyReason(
      for: untyped, slowThresholdMs: 3_000
    ))
  }

  /// The shape #3896 removed and this refactor makes unreachable: an attempt produced by a
  /// bounded-recovery step — the leading probe or the trailing bounded tier, on either the
  /// Simulator deferred plan or the physical-device bounded plan — has no arming branch at all,
  /// whatever its timing or failure. The attempt carries its step, so there is no channel-state
  /// argument left to forget. Ordinary tree attempts must still penalize on the same facts.
  func testBoundedRecoveryAttemptsCannotRenewPenaltyOnEitherPlatformPlan() {
    let timeout = SnapshotCaptureFailure(
      code: Self.xCTestSnapshotTimeoutCode, message: "test timeout", hint: "test"
    )
    let attempts: [(
      outcome: SnapshotBackendAttempt.Outcome, timing: SnapshotCaptureTiming, tier: SnapshotTierOutcome
    )] = [
      (.failed(timeout, phase: .acquisition), SnapshotCaptureTiming(acquisitionMs: 1_000, presentationMs: 0), .completed),
      (.noCapture, SnapshotCaptureTiming(acquisitionMs: 1_000, presentationMs: 0), .deadlineExhausted),
      (.noCapture, SnapshotCaptureTiming(acquisitionMs: 3_001, presentationMs: 0), .completed),
    ]
    for claimsProbe in [true, false] {
      for kind in [SnapshotBackendKind.recursiveTree, .querySweep] {
        for attempt in attempts {
          XCTAssertNil(Self.snapshotXCTestPenaltyReason(
            for: SnapshotBackendAttempt(
              step: .boundedRecovery(kind, claimsPeriodicProbe: claimsProbe),
              outcome: attempt.outcome,
              timing: attempt.timing,
              tierOutcome: attempt.tier
            ),
            slowThresholdMs: 3_000
          ))
        }
      }
    }
    for attempt in attempts {
      XCTAssertNotNil(Self.snapshotXCTestPenaltyReason(
        for: SnapshotBackendAttempt(
          step: .ordinary(.recursiveTree),
          outcome: attempt.outcome,
          timing: attempt.timing,
          tierOutcome: attempt.tier
        ),
        slowThresholdMs: 3_000
      ), "ordinary tree timeouts and slow acquisitions must still penalize")
    }
  }
}
#endif
