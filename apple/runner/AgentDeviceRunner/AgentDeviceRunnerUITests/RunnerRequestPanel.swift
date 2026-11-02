import XCTest

// The lit panel of the command in flight (ADR 0025). It is main-owned, and `executeAccepted` writes
// it onto the main queue ahead of the command's own main-thread work. Main work a previous command
// abandoned therefore runs first and still reads that command's panel. A recording pump outlives
// its command, so `recordStart` reads the panel once and carries it.
struct LitPanelSurface {
  let app: XCUIApplication
  let displayID: UInt
  let window: XCUIElement
  let frame: CGRect
}

/// The command's lit panel and what it booked on it. Read and written only on the main thread.
final class RunnerLitPanelState {
  var panel: RunnerLitPanel?
  var surface: LitPanelSurface?
  var windows: (app: XCUIApplication, elements: [XCUIElement])?
}

extension RunnerTests {
  func setRequestLitPanel(from command: Command) {
    var panel: RunnerLitPanel?
    if let fact = command.litPanel, fact.displayId != 0, fact.widthPt.isFinite, fact.heightPt.isFinite,
      fact.widthPt > 0, fact.heightPt > 0
    {
      panel = RunnerLitPanel(displayID: fact.displayId, widthPt: fact.widthPt, heightPt: fact.heightPt)
    }
    let state = litPanelState
    let write = {
      state.panel = panel
      state.surface = nil
      state.windows = nil
    }
    if Thread.isMainThread {
      write()
    } else {
      DispatchQueue.main.async(execute: write)
    }
  }

  /// The lit panel the current request named, or nil for a single-panel request. Main only.
  var requestLitPanel: RunnerLitPanel? { litPanelState.panel }

  /// Books `app`'s window on the lit panel for the rest of the request, or returns why it cannot. A
  /// request that named no panel books nothing. Later surface reads of `app` answer with this
  /// window, so none of them can fall back to the application's own coordinates.
  func bookRequestLitPanelSurface(app: XCUIApplication) -> RunnerAppScreenCaptureFailure? {
    guard let litPanel = requestLitPanel else { return nil }
    if let booked = litPanelState.surface, booked.app === app { return nil }
    var window: AnyObject?
    var frame = CGRect.null
    let failure = RunnerResolveLitPanelWindow(app, litPanel, &window, &frame)
    guard failure == .none, let element = window as? XCUIElement else {
      return RunnerAppScreenCaptureFailure(failure == .none ? .unresolvedWindow : failure)
    }
    litPanelState.surface = LitPanelSurface(app: app, displayID: litPanel.displayID, window: element, frame: frame)
    return nil
  }

  /// Where an element read searches: the application, or on a lit-panel request only the windows
  /// proven on the lit display. A list that cannot be read throws `APP_SCREEN_UNRESOLVED`. The walk
  /// runs inside an issue scope, so a window that vanishes mid-walk refuses instead of ending the
  /// session (#2995).
  func elementSearchRoots(app: XCUIApplication) throws -> [XCUIElement] {
    guard let litPanel = requestLitPanel else { return [app] }
    if let cached = litPanelState.windows, cached.app === app { return cached.elements }
    var windows: [XCUIElement]?
    let walk = holdingRecordedIssues {
      windows = RunnerCopyLitPanelWindows(app, litPanel)?.compactMap { $0 as? XCUIElement }
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
      if litPanelWindowWalkIssueForTesting {
        record(XCTIssue(type: .assertionFailure, compactDescription: "Window vanished during the lit-panel walk"))
      }
#endif
    }
    guard walk.issues.isEmpty, walk.exceptionMessage == nil, let windows else {
      throw RunnerAppScreenCaptureFailure.unresolvedScreen
    }
    litPanelState.windows = (app, windows)
    return windows
  }

  func elementQueries(app: XCUIApplication, matching type: XCUIElement.ElementType) throws -> [XCUIElementQuery] {
    try elementSearchRoots(app: app).map { $0.descendants(matching: type) }
  }
}
