import XCTest
#if canImport(UIKit)
import UIKit
#endif

/// One capture of the display that actually hosts the target app, with the facts needed to read its
/// pixels without guessing a panel: which display was captured, how many pixels the encoded image
/// holds, and how many of them represent one point.
struct CapturedAppScreen {
  let image: RunnerImage
  let displayID: UInt
  let pixelWidth: Int
  let pixelHeight: Int
  let pixelsPerPoint: Double
}

/// Why the runner could not name the display hosting the target app. Carried as a reason code
/// rather than as message text so a required capture can fail closed with a code the host keys on,
/// and an optional observation can report "unknown" without parsing a sentence (#2728).
enum RunnerAppScreenCaptureFailure: String, Error {
  case unresolvedWindow = "APP_SCREEN_WINDOW_UNRESOLVED"
  case unresolvedScreen = "APP_SCREEN_UNRESOLVED"
  case unrenderableImage = "APP_SCREEN_CAPTURE_UNRENDERABLE"

  init(_ failure: RunnerApplicationScreenFailure) {
    switch failure {
    case .unresolvedWindow:
      self = .unresolvedWindow
    default:
      self = .unresolvedScreen
    }
  }

  var message: String {
    switch self {
    case .unresolvedWindow:
      return "Neither the target app nor the system surface resolved a window, so no display could be named."
    case .unresolvedScreen:
      return "The resolved app window did not report the display it is shown on."
    case .unrenderableImage:
      return "The resolved display handed back an image that could not be drawn upright."
    }
  }

  var hint: String {
    switch self {
    case .unresolvedWindow:
      return "The capture follows the display that owns a window, so this is a runtime that is answering no window for any process; runner.log names the window frame and the query answer it refused."
    case .unresolvedScreen:
      return "Retry the capture. If it persists, the XCTest runtime is not reporting the window's display; runner.log names the window frame it resolved."
    case .unrenderableImage:
      return "Retry the capture. The display was resolved, so this is the capture itself failing, not a panel question."
    }
  }
}

extension RunnerTests {
  /// The target rule, kept apart from the two queries so the rule itself is testable: an unresolved
  /// window asks the system surface, and nothing else does.
  func selectObservedScreenCapture(
    resolving: () -> Result<CapturedAppScreen, RunnerAppScreenCaptureFailure>,
    fallingBack: () -> Result<CapturedAppScreen, RunnerAppScreenCaptureFailure>
  ) -> Result<CapturedAppScreen, RunnerAppScreenCaptureFailure> {
    let outcome = resolving()
    if case .failure(.unresolvedWindow) = outcome {
      return fallingBack()
    }
    return outcome
  }
}

#if canImport(UIKit) && os(iOS)
extension RunnerTests {
  /// Captures the display hosting `app` instead of `XCUIScreen.main`.
  ///
  /// On a foldable, `XCUIScreen.main` names one fixed panel while the app can be on the other, and
  /// the panel that is dark still answers with a valid PNG of black — a capture that looks like
  /// evidence and proves nothing. The window's own screen is the only source that follows the app,
  /// and on a panel the system presents turned it hands back an image whose buffer is sideways, so
  /// the pixels are redrawn upright at that image's own logical size and scale before anyone
  /// encodes or compares them (#2728).
  ///
  /// Never activates `app`: an observation must not change which app is foregrounded just to get a
  /// screen, so the caller passes the app context it already intends to observe.
  func captureResolvedAppScreen(
    app: XCUIApplication
  ) -> Result<CapturedAppScreen, RunnerAppScreenCaptureFailure> {
    var outcome: Result<CapturedAppScreen, RunnerAppScreenCaptureFailure> = .failure(
      .unresolvedScreen
    )
    let capture = {
      outcome = Self.resolveCapturedAppScreen(app: app)
    }
    if Thread.isMainThread {
      capture()
    } else {
      DispatchQueue.main.sync(execute: capture)
    }
    return outcome
  }

  /// Captures the display a caller should observe, asking `app` first and the system surface second.
  ///
  /// A capture with no session app, or with one that is not running, still has a window on screen:
  /// the home screen is SpringBoard's window, and its panel is the lit one. Asking the system surface
  /// keeps that capture honest — it names a display a window actually occupies instead of reaching
  /// for `XCUIScreen.main`, which on a foldable is one fixed panel whether or not it is dark (#2728).
  ///
  /// Only an unresolved *window* moves on to the system surface. A window that resolved and then
  /// refused to name its display is the failure the host has to see, and no second question about a
  /// different process should bury it.
  func captureObservedScreen(app: XCUIApplication) -> Result<
    CapturedAppScreen, RunnerAppScreenCaptureFailure
  > {
    selectObservedScreenCapture(
      resolving: { captureResolvedAppScreen(app: app) },
      fallingBack: { captureResolvedAppScreen(app: springboard) }
    )
  }

  private static func resolveCapturedAppScreen(
    app: XCUIApplication
  ) -> Result<CapturedAppScreen, RunnerAppScreenCaptureFailure> {
    var screen: AnyObject?
    var displayID: UInt = 0
    var resolution: RunnerApplicationScreenFailure = .unresolvedScreen
    guard RunnerResolveApplicationScreen(app, &screen, &displayID, &resolution),
      let captureScreen = screen as? XCUIScreen
    else {
      return .failure(RunnerAppScreenCaptureFailure(resolution))
    }
    let image = captureScreen.screenshot().image
    guard let upright = runnerUprightCaptureImage(image) else {
      return .failure(.unrenderableImage)
    }
    // A scale that is not a finite positive number cannot be reported to a host that divides by it,
    // and cannot be drawn at, so the capture is refused rather than encoded with a value JSON cannot
    // carry (#2728).
    guard upright.scale.isFinite, upright.scale > 0 else {
      return .failure(.unrenderableImage)
    }
    guard let cgImage = runnerCGImage(from: upright) else {
      return .failure(.unrenderableImage)
    }
    // A zero-pixel image is a capture that did not happen, not a tiny one. Refusing it here — at the
    // type that owns the fact — keeps a required consumer (a recording sizing its writer from this
    // frame) from mistaking it for a usable frame and falling back to an untyped error (#2728).
    guard cgImage.width > 0, cgImage.height > 0 else {
      return .failure(.unrenderableImage)
    }
    return .success(
      CapturedAppScreen(
        image: upright,
        displayID: displayID,
        pixelWidth: cgImage.width,
        pixelHeight: cgImage.height,
        pixelsPerPoint: Double(upright.scale)
      )
    )
  }

  /// Redraws a turned capture so its encoded rows run the way the panel is presented, and leaves an
  /// already-upright capture untouched so a single-panel capture keeps the exact bytes it produced
  /// before panels existed. The draw box is the image's own oriented logical size and the renderer's
  /// scale is the image's own scale: neither comes from a nominal panel size, and the one-pixel
  /// difference between what XCTest hands back and what CoreDevice calls the panel is preserved
  /// rather than stretched away (#2728).
  private static func runnerUprightCaptureImage(_ image: UIImage) -> UIImage? {
    if image.imageOrientation == .up {
      return image
    }
    guard image.size.width > 0, image.size.height > 0, image.scale.isFinite, image.scale > 0 else {
      return nil
    }
    let format = UIGraphicsImageRendererFormat()
    format.scale = image.scale
    let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
  }
}
#endif
