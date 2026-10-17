import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// Captures the session app's front window by itself: windows above it, the ghost cursor, and
/// the rest of the desktop are not in the image, so the app may sit behind the user's work.
func captureAppWindowScreenshot(app: NSRunningApplication, outPath: String) throws {
  guard #available(macOS 14.0, *) else {
    throw HelperError.commandFailed("app window screenshots require macOS 14 or newer")
  }
  let pid = app.processIdentifier
  let front = try frontWindow(pid: pid)
  let content = try awaitShareableContent()
  let candidates = content.windows.filter { $0.owningApplication?.processID == pid }
  let window: SCWindow
  switch frontShareableWindow(candidates, front: front, windowID: { Int($0.windowID) }) {
  case .success(let shareable):
    window = shareable
  case .failure(let refusal):
    throw refusal.error(bundleId: app.bundleIdentifier)
  }

  let filter = SCContentFilter(desktopIndependentWindow: window)
  let configuration = SCStreamConfiguration()
  let scale = CGFloat(filter.pointPixelScale)
  configuration.width = Int(filter.contentRect.width * scale)
  configuration.height = Int(filter.contentRect.height * scale)
  configuration.showsCursor = false
  configuration.ignoreShadowsSingleWindow = true

  let semaphore = DispatchSemaphore(value: 0)
  var capturedImage: CGImage?
  var capturedError: Error?
  SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
    capturedImage = image
    capturedError = error
    semaphore.signal()
  }
  semaphore.wait()
  if let error = capturedError as NSError? {
    throw screenshotFailure(error, surface: "app")
  }
  guard let capturedImage else {
    throw HelperError.commandFailed("screenshot failed")
  }
  try writePNG(capturedImage, to: outPath)
}

/// Why an app screenshot refuses, and the error the host reports for it: reason, remedy, and the
/// front window it refused. The capture is the app's front window or nothing; another window of
/// the app would show state the user is not looking at.
enum AppWindowScreenshotRefusal: Error {
  case windowNotFound
  case frontWindowNotShareable(frontWindowId: Int)
  case frontWindowCaptureExcluded(frontWindowId: Int)

  func error(bundleId: String?) -> HelperError {
    var details = ["bundleId": bundleId ?? ""]
    let message: String
    switch self {
    case .windowNotFound:
      details["reason"] = "window-not-found"
      details["hint"] =
        "Open or unminimize a window of the app on the current Space, then retry the screenshot."
      message = "screenshot could not find an on-screen window for the app"
    case .frontWindowCaptureExcluded(let frontWindowId):
      details["reason"] = "front-window-capture-excluded"
      details["frontWindowId"] = String(frontWindowId)
      details["hint"] =
        "The app excludes the front window from screen capture. Run `snapshot` to read the window's UI tree; retrying the excluded window will not help."
      message =
        "screenshot could not capture the app's front window: the app excludes it from capture"
    case .frontWindowNotShareable(let frontWindowId):
      details["reason"] = "front-window-not-shareable"
      details["frontWindowId"] = String(frontWindowId)
      details["hint"] =
        "The front window is unavailable to screen capture. If it is opening or closing, retry after it settles."
      message =
        "screenshot could not capture the app's front window: ScreenCaptureKit does not offer it"
    }
    return .commandFailed(message, details: details)
  }
}

/// The shareable candidate that is the app's front window, or the reason the screenshot refuses.
func frontShareableWindow<Window>(
  _ candidates: [Window],
  front: OnScreenWindow?,
  windowID: (Window) -> Int
) -> Result<Window, AppWindowScreenshotRefusal> {
  guard let front else { return .failure(.windowNotFound) }
  guard front.sharingState != 0 else {
    return .failure(.frontWindowCaptureExcluded(frontWindowId: front.number))
  }
  guard let shareable = candidates.first(where: { windowID($0) == front.number }) else {
    return .failure(.frontWindowNotShareable(frontWindowId: front.number))
  }
  return .success(shareable)
}

@available(macOS 14.0, *)
private func awaitShareableContent() throws -> SCShareableContent {
  let semaphore = DispatchSemaphore(value: 0)
  var shareable: SCShareableContent?
  var failure: Error?
  SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
    shareable = content
    failure = error
    semaphore.signal()
  }
  semaphore.wait()
  if let error = failure as NSError? {
    throw screenshotFailure(error, surface: "app")
  }
  guard let shareable else {
    throw HelperError.commandFailed("screenshot could not list shareable windows")
  }
  return shareable
}
