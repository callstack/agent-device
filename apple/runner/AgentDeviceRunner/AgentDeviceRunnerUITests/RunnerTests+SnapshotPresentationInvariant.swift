import AgentDeviceSnapshotPresentation

extension RunnerTests {
  static func snapshotCaptureFailure(
    for failure: SnapshotPresentationFailure
  ) -> SnapshotCaptureFailure {
    SnapshotCaptureFailure(
      code: failure.code,
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
