import XCTest

// The lit panel of the command in flight (ADR 0025). Commands run one at a time on
// `commandExecutionQueue`, where the slot is written, and the surface resolvers read it on main.
// A recording pump outlives its command, so `recordStart` reads the panel once and carries it.
extension RunnerTests {
  struct LitPanelSurface {
    let window: XCUIElement
    let frame: CGRect
  }

  func setRequestLitPanel(from command: Command) {
    var panel: RunnerLitPanel?
    if let fact = command.litPanel, fact.displayId != 0, fact.widthPt.isFinite, fact.heightPt.isFinite,
      fact.widthPt > 0, fact.heightPt > 0
    {
      panel = RunnerLitPanel(displayID: fact.displayId, widthPt: fact.widthPt, heightPt: fact.heightPt)
    }
    requestPanelLock.lock()
    requestLitPanel = panel
    requestLitSurface = nil
    requestPanelLock.unlock()
  }

  /// The lit panel the current request named, or nil for a single-panel request.
  var requestSurfacePanel: RunnerLitPanel? {
    requestPanelLock.lock()
    defer { requestPanelLock.unlock() }
    return requestLitPanel
  }

  /// Books the lit panel's window for the rest of the request, or returns why it cannot. A request
  /// that named no panel books nothing. Once booked, every surface read in the request answers with
  /// this window, so no later read can fall back to the application's own coordinates.
  func bookRequestLitPanelSurface(app: XCUIApplication) -> RunnerAppScreenCaptureFailure? {
    guard let litPanel = requestSurfacePanel else { return nil }
    switch Self.resolveLitPanelSurface(app: app, litPanel: litPanel) {
    case .failure(let refusal):
      return refusal
    case .success(let surface):
      requestPanelLock.lock()
      requestLitSurface = surface
      requestPanelLock.unlock()
      return nil
    }
  }

  var bookedLitPanelSurface: LitPanelSurface? {
    requestPanelLock.lock()
    defer { requestPanelLock.unlock() }
    return requestLitSurface
  }

  static func resolveLitPanelSurface(
    app: AnyObject,
    litPanel: RunnerLitPanel
  ) -> Result<LitPanelSurface, RunnerAppScreenCaptureFailure> {
    var window: AnyObject?
    var frame = CGRect.null
    let failure = RunnerResolveLitPanelWindow(app, litPanel, &window, &frame)
    guard failure == .none, let element = window as? XCUIElement else {
      return .failure(RunnerAppScreenCaptureFailure(failure == .none ? .unresolvedWindow : failure))
    }
    return .success(LitPanelSurface(window: element, frame: frame))
  }
}
