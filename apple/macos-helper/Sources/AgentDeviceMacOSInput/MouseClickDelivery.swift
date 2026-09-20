import CoreGraphics
import Foundation

public struct MouseClickRequest: Equatable, Sendable {
  public let x: Double
  public let y: Double
  /// How long the button stays down. Zero asks for the default hold.
  public let holdMs: Int
  public let clicks: Int
  public let intervalMs: Int

  public init(x: Double, y: Double, holdMs: Int = 0, clicks: Int = 1, intervalMs: Int = 120) {
    self.x = x
    self.y = y
    self.holdMs = holdMs
    self.clicks = clicks
    self.intervalMs = intervalMs
  }
}

public enum MouseClickDeliveryError: Error, Equatable {
  case eventCreationFailed
}

/// Posts a click the way a trackpad would: one motion to the point, then a press that is
/// held long enough for the app to accept the release, repeated with a rising click state
/// so a second press reads as a double-click rather than two independent taps.
public func postMouseClick(_ request: MouseClickRequest) throws {
  let point = CGPoint(x: request.x, y: request.y)
  let steps = mouseClickSteps(holdMs: request.holdMs, clicks: request.clicks, intervalMs: request.intervalMs)
  var clickState = 0
  var postedAny = false

  for step in steps {
    if postedAny && step.delayBeforeMs > 0 {
      usleep(UInt32(step.delayBeforeMs) * 1000)
    }
    let event: CGEvent?
    switch step.kind {
    case .move:
      event = CGEvent(
        mouseEventSource: nil,
        mouseType: .mouseMoved,
        mouseCursorPosition: point,
        mouseButton: .left
      )
    case .down:
      clickState += 1
      event = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseDown,
        mouseCursorPosition: point,
        mouseButton: .left
      )
      event?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
    case .up:
      event = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseUp,
        mouseCursorPosition: point,
        mouseButton: .left
      )
      event?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
    }
    guard let event else {
      throw MouseClickDeliveryError.eventCreationFailed
    }
    event.post(tap: .cghidEventTap)
    postedAny = true
  }
}
