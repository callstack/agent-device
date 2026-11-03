import XCTest

// The lit panel of the command in flight (ADR 0025), main-owned and written behind main work a
// previous command left queued, so that work still reads its own command's panel.
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

  /// Books `app`'s lit-panel window for the request, or returns why it cannot. The booked frame is
  /// the panel's box turned like the window, so a partial window maps into the whole screen.
  func bookRequestLitPanelSurface(app: XCUIApplication) -> RunnerAppScreenCaptureFailure? {
    guard let litPanel = requestLitPanel else { return nil }
    if let booked = litPanelState.surface, booked.app === app { return nil }
    var window: AnyObject?
    var frame = CGRect.null
    var screen: AnyObject?
    let failure = RunnerResolveLitPanelWindow(app, litPanel, &window, &frame, &screen)
    guard failure == .none, let element = window as? XCUIElement else {
      return RunnerAppScreenCaptureFailure(failure == .none ? .unresolvedWindow : failure)
    }
    litPanelState.surface = LitPanelSurface(
      app: app,
      displayID: litPanel.displayID,
      window: element,
      frame: Self.litPanelScreenFrame(litPanel, windowFrame: frame)
    )
    return nil
  }

  static func litPanelScreenFrame(_ panel: RunnerLitPanel, windowFrame: CGRect) -> CGRect {
    let long = max(panel.widthPt, panel.heightPt)
    let short = min(panel.widthPt, panel.heightPt)
    let turned = windowFrame.width > windowFrame.height
    return CGRect(origin: windowFrame.origin, size: turned ? CGSize(width: long, height: short) : CGSize(width: short, height: long))
  }

  /// The roots of every element read: the app, or the windows proven on the lit display. A walk that
  /// cannot read the list, or that records an issue (#2995), throws `APP_SCREEN_UNRESOLVED`.
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
