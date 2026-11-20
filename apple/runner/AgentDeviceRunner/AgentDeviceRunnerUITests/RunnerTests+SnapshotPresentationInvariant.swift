import AgentDeviceSnapshotPresentation

extension RunnerTests {
  /// The library names this refusal by its own `SnapshotPresentationFailure.code` literal
  /// (apple/snapshot-presentation/Sources/AgentDeviceSnapshotPresentation/SnapshotPresentationFailure.swift).
  /// That literal never reaches the wire: the library cannot import this target's enum, and the
  /// runner's wire vocabulary is closed, so the bridge drops it and answers with the runner's own
  /// `RunnerPassThroughErrorCode` constant, carrying the library's message and hint beside it. The
  /// library owns WHEN the refusal happens; the parity guard owns the code the caller sees.
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
