import AgentDeviceSnapshotPresentation

extension RunnerTests {
  /// The library owns this code's literal — `SnapshotPresentationFailure.code` in
  /// apple/snapshot-presentation/Sources/AgentDeviceSnapshotPresentation/SnapshotPresentationFailure.swift
  /// answers it for every case, and that library cannot import this target's enum. The bridge emits
  /// the runner's own constant for it, so the code that reaches the wire is a named row of
  /// `RunnerPassThroughErrorCode`; the two literals are kept equal by the parity guard's pass-through
  /// set, and a library-side change to that string shows up there rather than drifting silently.
  static func snapshotCaptureFailure(
    for failure: SnapshotPresentationFailure
  ) -> SnapshotCaptureFailure {
    SnapshotCaptureFailure(
      code: RunnerPassThroughErrorCode.iosSnapshotPresentationFailed,
      message: failure.message,
      hint: failure.hint,
      qualityReasonCode: failure.qualityReasonCode
    )
  }

  static func snapshotQualityReasonCode(for failure: SnapshotCaptureFailure) -> String {
    failure.qualityReasonCode
      ?? (Self.isAxSnapshotFailure(failure) ? "ax-rejected" : "capture-failed")
  }
}
