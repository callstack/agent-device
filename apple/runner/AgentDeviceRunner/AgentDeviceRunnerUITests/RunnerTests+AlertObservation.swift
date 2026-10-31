import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  func captureAlertPresentation(_ element: XCUIElement) -> AlertSurfacePresentation? {
    var presentation: AlertSurfacePresentation?
    _ = RunnerObjCExceptionCatcher.catchException {
      guard let snapshot = try? element.snapshot() else { return }
      presentation = AlertSurface.presentation(of: self.alertSurfaceNode(snapshot))
    }
    return presentation
  }

  func observeAlert(
    in ownerApp: XCUIApplication,
    source: AlertSurfaceSource,
    observesApplicationRoot: Bool,
    deadline: Date
  ) -> RunnerAlertObservation {
    guard Date() < deadline else { return .deadlineExceeded }
    var observation = RunnerAlertObservation.unavailable
    _ = RunnerObjCExceptionCatcher.catchException {
      switch ownerApp.state {
      case .notRunning:
        observation = .absent
        return
      case .runningForeground, .runningBackground:
        break
#if !os(macOS)
      case .runningBackgroundSuspended:
        break
#endif
      case .unknown:
        return
      @unknown default:
        return
      }
      guard Date() < deadline, let snapshot = try? ownerApp.snapshot(),
            !snapshot.children.isEmpty, !snapshot.frame.isNull, !snapshot.frame.isEmpty else { return }
      let root = self.alertSurfaceNode(snapshot)
      if observesApplicationRoot {
        observation = .visible(AlertSurface.presentation(of: root))
        return
      }
      let candidates = AlertSurface.candidates(in: root, source: source, viewport: root.frame)
      guard candidates.count <= 1 else { return }
      observation = candidates.first.map { .visible(AlertSurface.presentation(of: $0)) } ?? .absent
    }
    return Date() < deadline ? observation : .deadlineExceeded
  }

  /// The tree the alert rules read. Snapshot output has no names for alerts and sheets, so the
  /// rules name them here.
  func alertSurfaceNode(_ snapshot: XCUIElementSnapshot) -> AlertSurfaceNode {
    let type: String
    switch snapshot.elementType {
    case .alert: type = "Alert"
    case .sheet: type = "Sheet"
    default: type = elementTypeName(snapshot.elementType)
    }
    return AlertSurfaceNode(
      type: type,
      identifier: snapshot.identifier,
      label: snapshot.label,
      frame: snapshot.frame,
      children: snapshot.children.map { alertSurfaceNode($0) }
    )
  }

  func alertVerificationResponse(
    _ verification: RunnerAlertVerification,
    action: String,
    activated: Bool
  ) -> Response {
    let code: String
    let message: String
    switch verification {
    case .disappeared, .presentationChanged:
      return Response(ok: true, data: DataPayload(message: action == "accept" ? "accepted" : "dismissed"))
    case .timedOut:
      code = "ALERT_DEADLINE_EXCEEDED"
      message = "alert \(action) exhausted its deadline"
    case .stillVisible:
      code = "INTERACTION_FAILED"
      message = "alert \(action) still observes an unchanged alert presentation"
    case .unconfirmed:
      code = "ALERT_CONFIRMATION_UNAVAILABLE"
      message = "alert \(action) could not read the alert presentation"
    }
    return Response(ok: false, error: ErrorPayload(
      code: code,
      message: message,
      hint: activated
        ? "The button was activated once. Inspect the current alert before deciding on another action."
        : RunnerTests.alertNoButtonActivatedHint
    ))
  }
}
