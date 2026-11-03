import XCTest

// The lit panel of the command in flight (ADR 0025), main-owned and written behind main work a
// previous command left queued, so that work still reads its own command's panel.
struct LitPanelBookingKey: Equatable {
  let bundleID: String
  let requestID: UUID
}

struct LitPanelSurface {
  let key: LitPanelBookingKey
  let displayID: UInt
  let window: XCUIElement
  let frame: CGRect
}

/// The command's lit panel and what it booked on it. Read and written only on the main thread.
final class RunnerLitPanelState {
  var requestID: UUID?
  var panel: RunnerLitPanel?
  var surface: LitPanelSurface?
}

extension RunnerTests {
  @discardableResult
  func setRequestLitPanel(from command: Command) -> UUID {
    let requestID = UUID()
    var panel: RunnerLitPanel?
    if let fact = command.litPanel, fact.displayId != 0, fact.widthPt.isFinite, fact.heightPt.isFinite,
      fact.widthPt > 0, fact.heightPt > 0
    {
      panel = RunnerLitPanel(displayID: fact.displayId, widthPt: fact.widthPt, heightPt: fact.heightPt)
    }
    let state = litPanelState
    let write = {
      state.requestID = requestID
      state.panel = panel
      state.surface = nil
    }
    if Thread.isMainThread {
      write()
    } else {
      DispatchQueue.main.async(execute: write)
    }
    return requestID
  }

  func endRequestLitPanel(_ requestID: UUID) {
    let state = litPanelState
    let clear = {
      guard state.requestID == requestID else { return }
      state.requestID = nil
      state.panel = nil
      state.surface = nil
    }
    if Thread.isMainThread {
      clear()
    } else {
      DispatchQueue.main.async(execute: clear)
    }
  }

  /// The lit panel the current request named, or nil for a single-panel request. Main only.
  var requestLitPanel: RunnerLitPanel? { litPanelState.panel }

  /// Books `app`'s lit-panel window for the request, or returns why it cannot.
  func bookRequestLitPanelSurface(app: XCUIApplication) -> RunnerAppScreenCaptureFailure? {
    guard let litPanel = requestLitPanel else { return nil }
    guard let requestID = litPanelState.requestID,
      let bundleID = safely("LIT_PANEL_APP_IDENTITY", { app.value(forKey: "bundleID") as? String })?.trimmedNonEmpty
    else { return .unresolvedScreen }
    let key = LitPanelBookingKey(bundleID: bundleID, requestID: requestID)
    if litPanelState.surface?.key == key { return nil }
    litPanelState.surface = nil
    var window: AnyObject?
    var frame = CGRect.null
    var screen: AnyObject?
    let failure = RunnerResolveLitPanelWindow(app, litPanel, &window, &frame, &screen)
    guard failure == .none, let element = window as? XCUIElement else {
      return RunnerAppScreenCaptureFailure(failure == .none ? .unresolvedWindow : failure)
    }
    litPanelState.surface = LitPanelSurface(key: key, displayID: litPanel.displayID, window: element, frame: frame)
    return nil
  }

  func requireRequestLitPanelSurface(app: XCUIApplication) throws -> LitPanelSurface {
    if let refusal = bookRequestLitPanelSurface(app: app) { throw refusal }
    guard let surface = litPanelState.surface else {
      throw RunnerAppScreenCaptureFailure.unresolvedScreen
    }
    return surface
  }

  /// The roots of every element read: the app, or the windows proven on the lit display. A walk that
  /// cannot read the list, or that records an issue (#2995), throws `APP_SCREEN_UNRESOLVED`.
  func elementSearchRoots(root: XCUIElement, litDisplayID: UInt?) throws -> [XCUIElement] {
    guard let litDisplayID else { return [root] }
    var windows: [XCUIElement]?
    let walk = holdingRecordedIssues {
      windows = RunnerCopyLitPanelWindows(root, litDisplayID)?.compactMap { $0 as? XCUIElement }
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
      if litPanelWindowWalkIssueForTesting {
        record(XCTIssue(type: .assertionFailure, compactDescription: "Window vanished during the lit-panel walk"))
      }
#endif
    }
    guard walk.issues.isEmpty, walk.exceptionMessage == nil, let windows, !windows.isEmpty else {
      for issue in walk.issues {
        NSLog("AGENT_DEVICE_RUNNER_LIT_PANEL_WALK_ISSUE=%@", issue.compactDescription)
      }
      NSLog(
        "AGENT_DEVICE_RUNNER_LIT_PANEL_WALK_REFUSED issues=%ld exception=%@ windows=%ld",
        walk.issues.count, walk.exceptionMessage ?? "none", windows?.count ?? -1
      )
      throw RunnerAppScreenCaptureFailure.unresolvedScreen
    }
    return windows
  }

  func elementQueries(app: XCUIApplication, matching type: XCUIElement.ElementType) throws -> [XCUIElementQuery] {
    try elementQueries(root: app, matching: type, litDisplayID: requestLitPanel?.displayID)
  }

  func elementQueries(
    root: XCUIElement,
    matching type: XCUIElement.ElementType,
    litDisplayID: UInt?
  ) throws -> [XCUIElementQuery] {
    try elementSearchRoots(root: root, litDisplayID: litDisplayID).map { $0.descendants(matching: type) }
  }
}
