import XCTest

extension RunnerTests {
  func captureAlertPresentation(_ element: XCUIElement) -> RunnerAlertPresentation? {
    var presentation: RunnerAlertPresentation?
    _ = RunnerObjCExceptionCatcher.catchException {
      guard let snapshot = try? element.snapshot() else { return }
      presentation = self.alertPresentation(snapshot)
    }
    return presentation
  }

  func observeAlert(
    in ownerApp: XCUIApplication,
    source: RunnerAlertSource,
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
      if observesApplicationRoot {
        observation = .visible(self.alertPresentation(snapshot))
        return
      }
      let candidates = self.alertSnapshots(in: snapshot, source: source, viewport: snapshot.frame)
      guard candidates.count <= 1 else { return }
      observation = candidates.first.map { .visible(self.alertPresentation($0)) } ?? .absent
    }
    return Date() < deadline ? observation : .deadlineExceeded
  }

  private func alertSnapshots(
    in snapshot: XCUIElementSnapshot,
    source: RunnerAlertSource,
    viewport: CGRect
  ) -> [XCUIElementSnapshot] {
    let frame = snapshot.frame
    let visible = !frame.isNull && !frame.isEmpty && viewport.contains(CGPoint(x: frame.midX, y: frame.midY))
    let matches: Bool
    switch source {
    case .blockingSystemModal:
      matches = snapshot.elementType == .alert || snapshot.elementType == .sheet
    case .appAlert:
      matches = snapshot.elementType == .alert
    case .dismissPopup:
      matches = snapshot.elementType == .window && containsDismissPopupMarker(snapshot)
    }
    if matches && visible { return [snapshot] }
    return snapshot.children.flatMap { alertSnapshots(in: $0, source: source, viewport: viewport) }
  }

  private func containsDismissPopupMarker(_ snapshot: XCUIElementSnapshot) -> Bool {
    [snapshot.label, snapshot.identifier].contains {
      $0.trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare("dismiss popup") == .orderedSame
    } || snapshot.children.contains { containsDismissPopupMarker($0) }
  }

  private func alertPresentation(_ snapshot: XCUIElementSnapshot) -> RunnerAlertPresentation {
    var content: [String] = []
    var buttons: [String] = []
    func collect(_ node: XCUIElementSnapshot) {
      let label = node.label.trimmingCharacters(in: .whitespacesAndNewlines)
      if actionableTypes.contains(node.elementType) {
        buttons.append(label)
      } else if !label.isEmpty {
        content.append(label)
      }
      node.children.forEach(collect)
    }
    snapshot.children.forEach(collect)
    return RunnerAlertPresentation(
      title: snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines),
      content: content,
      buttons: buttons
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
        : "No alert button was activated. Inspect the current alert before deciding on an action."
    ))
  }
}
