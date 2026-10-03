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
  let frontWindowID = frontWindowNumber(pid: pid)
  let content = try awaitShareableContent()
  let candidates = content.windows.filter {
    $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 0
      && $0.frame.height > 0
  }
  guard
    let window = candidates.first(where: { Int($0.windowID) == frontWindowID })
      ?? candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
  else {
    throw HelperError.commandFailed(
      "screenshot could not find a window for the app",
      details: ["reason": "window-not-found", "bundleId": app.bundleIdentifier ?? ""]
    )
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
