import XCTest

// MARK: - Request-scoped lit panel (#2728, ADR 0025)
//
// A foldable lights one panel at a time, and only the host can say which: the runner has no hinge to
// read, and geometry cannot settle it, because the dark panel's windows have perfectly good frames.
// So the host reads the panel table for the request and names the lit panel in it (`Command.litPanel`),
// and every surface resolver books its window against that fact rather than against the application's
// first window — which on a foldable home screen is SpringBoard's status-bar window.
//
// The resolvers that need the fact sit on the gesture, snapshot, capture and synthesized-dispatch
// paths. Each of them runs the command that carries the fact, and none of them has the `Command` in
// scope: the viewport read is a hop inside a capture plan, the capture answers through a result type,
// and a gesture path is handed a context rather than a request. So the runner holds the panel of the
// command in flight in one place, which is also the only place that answers the question.
//
// Commands are served one at a time on `commandExecutionQueue`, which is where the slot is written.
// Readers run on main, so the slot is lock-guarded rather than plain main-owned state, the same split
// `SnapshotProbePenaltyIdentity` makes. Main-queue work abandoned by the execution watchdog can
// therefore read the panel of the command that replaced it; the resolution marker the bridge logs
// names the panel a window was booked against, so such a resolution is visible, not silent.

extension RunnerTests {
  /// Records the panel the command about to be served names as lit. A request that names none clears
  /// the slot, so a command for a single-panel device can never inherit a foldable's panel.
  func setRequestLitPanel(from command: Command) {
    requestPanelLock.lock()
    requestLitPanel = command.litPanel
    requestPanelLock.unlock()
  }

  /// The lit panel in the units the surface rule compares a window against. An unnamed or unusable
  /// panel answers `displayID` 0, which every resolver reads as "keep the historic first-window
  /// route": a panel that cannot be named cannot be compared with a window.
  var requestSurfacePanel: RunnerLitPanel {
    requestPanelLock.lock()
    let panel = requestLitPanel
    requestPanelLock.unlock()
    guard let panel, panel.displayId != 0, panel.widthPt.isFinite, panel.heightPt.isFinite,
      panel.widthPt > 0, panel.heightPt > 0
    else {
      return RunnerLitPanel(displayID: 0, widthPt: 0, heightPt: 0)
    }
    return panel.surfacePanel
  }
}
