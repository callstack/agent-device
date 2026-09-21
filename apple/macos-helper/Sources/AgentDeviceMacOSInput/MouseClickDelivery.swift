import CoreGraphics
import Foundation

public struct MouseClickRequest: Equatable, Sendable {
  public let x: Double
  public let y: Double
  /// How long the button stays down. Zero asks for the default hold.
  public let holdMs: Int
  /// Independent presses, each at click state 1.
  public let clicks: Int
  /// Post every press as a double-click pair with a rising click state.
  public let doubleClick: Bool
  public let intervalMs: Int

  public init(
    x: Double,
    y: Double,
    holdMs: Int = 0,
    clicks: Int = 1,
    doubleClick: Bool = false,
    intervalMs: Int = 120
  ) {
    self.x = x
    self.y = y
    self.holdMs = holdMs
    self.clicks = clicks
    self.doubleClick = doubleClick
    self.intervalMs = intervalMs
  }
}

public enum MouseClickDeliveryError: Error, Equatable {
  case eventCreationFailed
}

/// The button the helper currently holds down, kept where a signal handler can reach it.
/// A helper killed between a mouse-down and its mouse-up would otherwise leave the system's
/// primary button stuck down for whatever the user touches next.
nonisolated(unsafe) private var heldMouseButton: (point: CGPoint, clickState: Int)?

private func releaseHeldMouseButton() {
  guard let held = heldMouseButton else { return }
  heldMouseButton = nil
  let up = CGEvent(
    mouseEventSource: nil,
    mouseType: .leftMouseUp,
    mouseCursorPosition: held.point,
    mouseButton: .left
  )
  up?.setIntegerValueField(.mouseEventClickState, value: Int64(held.clickState))
  up?.post(tap: .cghidEventTap)
}

private func installMouseReleaseOnTermination() {
  for terminationSignal in [SIGTERM, SIGINT, SIGHUP] {
    signal(terminationSignal) { received in
      releaseHeldMouseButton()
      _exit(128 + received)
    }
  }
}

/// Posts a click the way a trackpad would: one motion to the point, then each press held
/// long enough for the app to accept the release. A termination signal that lands inside a
/// hold releases the button before the process exits.
public func postMouseClick(_ request: MouseClickRequest) throws {
  installMouseReleaseOnTermination()
  let point = CGPoint(x: request.x, y: request.y)
  let hold = mouseClickHoldMs(requestedMs: request.holdMs)
  let presses = mouseClickPresses(
    clicks: request.clicks,
    doubleClick: request.doubleClick,
    intervalMs: request.intervalMs
  )

  guard let move = CGEvent(
    mouseEventSource: nil,
    mouseType: .mouseMoved,
    mouseCursorPosition: point,
    mouseButton: .left
  ) else {
    throw MouseClickDeliveryError.eventCreationFailed
  }
  move.post(tap: .cghidEventTap)

  for press in presses {
    if press.delayBeforeMs > 0 {
      usleep(UInt32(press.delayBeforeMs) * 1000)
    }
    guard let down = CGEvent(
      mouseEventSource: nil,
      mouseType: .leftMouseDown,
      mouseCursorPosition: point,
      mouseButton: .left
    ), let up = CGEvent(
      mouseEventSource: nil,
      mouseType: .leftMouseUp,
      mouseCursorPosition: point,
      mouseButton: .left
    ) else {
      throw MouseClickDeliveryError.eventCreationFailed
    }
    down.setIntegerValueField(.mouseEventClickState, value: Int64(press.clickState))
    up.setIntegerValueField(.mouseEventClickState, value: Int64(press.clickState))
    heldMouseButton = (point, press.clickState)
    down.post(tap: .cghidEventTap)
    usleep(UInt32(hold) * 1000)
    heldMouseButton = nil
    up.post(tap: .cghidEventTap)
  }
}
