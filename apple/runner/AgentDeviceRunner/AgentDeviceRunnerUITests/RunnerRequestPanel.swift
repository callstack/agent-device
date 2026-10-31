import XCTest

// The lit panel of the command in flight (ADR 0025). Commands run one at a time on
// `commandExecutionQueue`, where the slot is written, and the surface resolvers read it on main.
// Work that outlives its command, such as a recording pump or a settle loop, reads it once and
// carries that panel instead.
extension RunnerTests {
  func setRequestLitPanel(from command: Command) {
    var panel: RunnerLitPanel?
    if let fact = command.litPanel, fact.displayId != 0, fact.widthPt.isFinite, fact.heightPt.isFinite,
      fact.widthPt > 0, fact.heightPt > 0
    {
      panel = RunnerLitPanel(displayID: fact.displayId, widthPt: fact.widthPt, heightPt: fact.heightPt)
    }
    requestPanelLock.lock()
    requestLitPanel = panel
    requestPanelLock.unlock()
  }

  /// The lit panel the current request named, or nil for a single-panel request.
  var requestSurfacePanel: RunnerLitPanel? {
    requestPanelLock.lock()
    defer { requestPanelLock.unlock() }
    return requestLitPanel
  }
}
