import XCTest

enum RunnerSurfacePolicy: String {
  case none
  case appWindows = "app-windows"
  case observedScreen = "observed-screen"
  case resolvedModal = "resolved-modal"
}

extension CommandType {
  var surfacePolicy: RunnerSurfacePolicy {
    switch self {
    case .mouseClick, .remotePress, .desktopScroll, .snapshotBridge, .home, .rotate,
      .actionButton, .volumeUp, .volumeDown, .keyboardReturn, .recordStop, .status, .uptime,
      .appState, .pasteboardWrite, .activate, .terminate, .targetReset, .shutdown:
      return .none
    case .tap, .longPress, .drag, .type, .swipe, .scroll, .findText, .querySelector, .pressReadiness, .readText,
      .snapshot, .backInApp, .backSystem, .gesture, .gestureViewport, .appSwitcher,
      .keyboardDismiss, .sequence:
      return .appWindows
    case .screenshot, .recordStart:
      return .observedScreen
    case .alert:
      return .resolvedModal
    }
  }
}

extension RunnerTests {
  @MainActor
  func prepareCommandSurface(command: Command, app: XCUIApplication) -> RunnerAppScreenCaptureFailure? {
    switch command.command.surfacePolicy {
    case .appWindows:
      return bookRequestLitPanelSurface(app: app)
    case .none, .observedScreen, .resolvedModal:
      return nil
    }
  }
}
