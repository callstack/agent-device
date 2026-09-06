struct RunnerAlertPresentation: Equatable {
  let title: String
  let content: [String]
  let buttons: [String]
}

enum RunnerAlertObservation {
  case visible(RunnerAlertPresentation)
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
    original: RunnerAlertPresentation,
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
