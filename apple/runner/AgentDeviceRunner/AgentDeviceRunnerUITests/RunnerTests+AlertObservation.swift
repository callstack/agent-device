import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  /// The answer to an `alert` request that resolved nothing. With a whole read's budget left before
  /// `deadline` it reads one snapshot and names the dialog-like containers none of the alert rules
  /// recognise; a read that fails, or a deadline too close to spend on one, leaves the plain
  /// not-found answer.
  func alertAbsence(in ownerApp: XCUIApplication, deadline: Date) -> AlertAbsence {
    alertAbsence(in: ownerApp, deadline: deadline) { [self] in nearMisses(in: ownerApp) }
  }

  /// The same answer with the read supplied, so a test can see whether the deadline let it run.
  func alertAbsence(
    in ownerApp: XCUIApplication,
    deadline: Date,
    reading nearMissRead: () -> [RunnerAlertNearMiss]
  ) -> AlertAbsence {
    guard deadline.timeIntervalSinceNow >= Self.nearMissReadAllowance else { return .unexplained }
    let nearMisses = nearMissRead()
    return nearMisses.isEmpty ? .unexplained : .nearMisses(nearMisses)
  }

  /// What one tree read costs at worst on a contended host, the figure `alertActivationDeadline`
  /// already budgets reads at. The read is a single `snapshot()` and XCTest cannot cancel one once
  /// it started, so this budget is what bounds it: the command's main-thread block is given the
  /// same deadline as its slice, and starting a read that cannot finish inside it would leave the
  /// block to be abandoned by the execution watchdog, which turns a refusal the caller can act on
  /// into `MAIN_THREAD_TIMEOUT` and a busy main thread for the commands behind it.
  static let nearMissReadAllowance: TimeInterval = 2.5

  /// One snapshot of the owner, read for dialog-like containers. A snapshot that fails, is empty,
  /// or has no frame explains nothing.
  private func nearMisses(in ownerApp: XCUIApplication) -> [RunnerAlertNearMiss] {
    var found: [RunnerAlertNearMiss] = []
    _ = RunnerObjCExceptionCatcher.catchException {
      guard let snapshot = try? ownerApp.snapshot(), !snapshot.children.isEmpty,
            !snapshot.frame.isNull, !snapshot.frame.isEmpty else { return }
      found = AlertSurface.nearMisses(in: alertSurfaceNode(snapshot), viewport: snapshot.frame)
        .map {
          RunnerAlertNearMiss(
            type: $0.type,
            identifier: $0.identifier,
            label: $0.label,
            buttons: $0.buttons
          )
        }
    }
    return found
  }

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
