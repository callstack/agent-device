import AgentDeviceSnapshotPresentation

enum RunnerAlertObservation {
  case visible(AlertSurfacePresentation)
  case absent
  case unavailable
  case deadlineExceeded
}

enum RunnerAlertVerification: Equatable {
  case disappeared
  case presentationChanged
  case stillVisible
  case unconfirmed
  case timedOut

  static func verify(
    original: AlertSurfacePresentation,
    observation: RunnerAlertObservation
  ) -> RunnerAlertVerification {
    switch observation {
    case .visible(let current):
      return original == current ? .stillVisible : .presentationChanged
    case .absent:
      return .disappeared
    case .unavailable:
      return .unconfirmed
    case .deadlineExceeded:
      return .timedOut
    }
  }
}
