import XCTest

enum RunnerInteractionOutcome {
  case performed
  /// A capability/state gap, surfaced to the caller as an UNSUPPORTED_OPERATION error.
  /// `hint` is an optional actionable next step (mapped to ErrorPayload.hint).
  case unsupported(message: String, hint: String?)
}

enum TvRemoteButton {
  case select
  case menu
  case home
  case up
  case down
  case left
  case right
}

extension RunnerTests {
  func resolveTvRemoteDoublePressDelay() -> TimeInterval {
    guard
      let raw = ProcessInfo.processInfo.environment["AGENT_DEVICE_TV_REMOTE_DOUBLE_PRESS_DELAY_MS"],
      !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      return tvRemoteDoublePressDelayDefault
    }
    guard let parsedMs = Double(raw), parsedMs >= 0 else {
      return tvRemoteDoublePressDelayDefault
    }
    return min(parsedMs, 1000) / 1000.0
  }

  @discardableResult
  func pressTvRemote(_ button: TvRemoteButton, duration: TimeInterval? = nil) -> Bool {
#if os(tvOS)
    let remoteButton = xcuiRemoteButton(button)
    if let duration, duration > 0 {
      XCUIRemote.shared.press(remoteButton, forDuration: duration)
    } else {
      XCUIRemote.shared.press(remoteButton)
    }
    return true
#else
    return false
#endif
  }

  func tvRemoteButton(from raw: String?) -> TvRemoteButton? {
    switch raw?.lowercased() {
    case "select":
      return .select
    case "menu":
      return .menu
    case "home":
      return .home
    case "up":
      return .up
    case "down":
      return .down
    case "left":
      return .left
    case "right":
      return .right
    default:
      return nil
    }
  }

  func elementHasFocus(_ element: XCUIElement) -> Bool {
    var focused = false
    _ = RunnerObjCExceptionCatcher.catchException({
      if let value = (element as NSObject).value(forKey: "hasFocus") as? Bool {
        focused = value
      }
    })
    return focused
  }

  func activateElement(app: XCUIApplication, element: XCUIElement, action: String) -> RunnerInteractionOutcome {
    if let outcome = selectFocusedTvElement(app: app, element: element, action: action) {
      return outcome
    }
#if os(tvOS)
    return performElementTap(element)
#else
    let frame = element.frame
    if !frame.isEmpty {
      // XCUIElement.tap() can fail the whole XCTest after navigation because it
      // re-resolves the tapped element even after the app removed it. Keep the
      // selector target semantic, then activate its resolved stable screen point.
      return tapAt(app: app, x: frame.midX, y: frame.midY)
    }
    return performElementTap(element)
#endif
  }

  func selectFocusedTvElement(app: XCUIApplication, point: CGPoint, action: String) -> RunnerInteractionOutcome? {
#if os(tvOS)
    guard let focused = focusedTvElement(app: app), !focused.frame.isEmpty, focused.frame.contains(point) else {
      return .unsupported(
        message: "\(action) is supported on tvOS only when the requested point is inside the focused element",
        hint: "Move focus with swipe or scroll until the target is focused, then retry."
      )
    }
    _ = pressTvRemote(.select)
    return .performed
#else
    return nil
#endif
  }

  func longSelectFocusedTvElement(app: XCUIApplication, point: CGPoint, duration: TimeInterval) -> RunnerInteractionOutcome? {
#if os(tvOS)
    guard let focused = focusedTvElement(app: app), !focused.frame.isEmpty, focused.frame.contains(point) else {
      return .unsupported(
        message: "long press is supported on tvOS only when the requested point is inside the focused element",
        hint: "Move focus with swipe or scroll until the target is focused, then retry."
      )
    }
    _ = pressTvRemote(.select, duration: duration)
    return .performed
#else
    return nil
#endif
  }

  private func performElementTap(_ element: XCUIElement) -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported(
      message: "element tap is not supported on tvOS; move focus with swipe or scroll, then select the focused element",
      hint: "Use swipe/scroll to move focus to the target, then select it; tvOS has no coordinate tap."
    )
#else
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      element.tap()
    })
    if let exceptionMessage {
      NSLog("AGENT_DEVICE_RUNNER_ELEMENT_TAP_IGNORED_EXCEPTION=%@", exceptionMessage)
      if isPostTapElementDisappearance(exceptionMessage) {
        return .performed
      }
      return .unsupported(message: "element tap failed: \(exceptionMessage)", hint: nil)
    }
    return .performed
#endif
  }

  private func isPostTapElementDisappearance(_ message: String) -> Bool {
    message.contains("No matches found")
      || message.contains("Failed to get matching snapshot")
  }

  private func selectFocusedTvElement(app: XCUIApplication, element: XCUIElement, action: String) -> RunnerInteractionOutcome? {
#if os(tvOS)
    guard tvFocusedElementMatches(app: app, target: element) else {
      return .unsupported(
        message: "\(action) is supported on tvOS only when the requested element is focused",
        hint: "Move focus to the target element first, then retry."
      )
    }
    _ = pressTvRemote(.select)
    return .performed
#else
    return nil
#endif
  }

  private func tvFocusedElementMatches(app: XCUIApplication, target: XCUIElement) -> Bool {
#if os(tvOS)
    if target.hasFocus {
      return true
    }
    guard let focused = focusedTvElement(app: app) else {
      return false
    }
    let targetFrame = target.frame
    let focusedFrame = focused.frame
    guard !targetFrame.isEmpty && !focusedFrame.isEmpty else {
      return false
    }
    let focusedCenter = CGPoint(x: focusedFrame.midX, y: focusedFrame.midY)
    let targetCenter = CGPoint(x: targetFrame.midX, y: targetFrame.midY)
    return targetFrame.contains(focusedCenter)
      || focusedFrame.contains(targetCenter)
      || targetFrame.intersects(focusedFrame)
#else
    return false
#endif
  }

  private func focusedTvElement(app: XCUIApplication) -> XCUIElement? {
#if os(tvOS)
    let focused = app
      .descendants(matching: .any)
      .matching(NSPredicate(format: "hasFocus == true"))
      .firstMatch
    return focused.exists ? focused : nil
#else
    return nil
#endif
  }

#if os(tvOS)
  private func xcuiRemoteButton(_ button: TvRemoteButton) -> XCUIRemote.Button {
    switch button {
    case .select:
      return .select
    case .menu:
      return .menu
    case .home:
      return .home
    case .up:
      return .up
    case .down:
      return .down
    case .left:
      return .left
    case .right:
      return .right
    }
  }
#endif
}
