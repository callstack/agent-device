import Foundation

public enum MouseClickStepKind: Equatable, Sendable {
  case move
  case down
  case up
}

public struct MouseClickStep: Equatable, Sendable {
  public let kind: MouseClickStepKind
  /// Milliseconds to wait after the previous step before posting this one.
  public let delayBeforeMs: Int

  public init(kind: MouseClickStepKind, delayBeforeMs: Int) {
    self.kind = kind
    self.delayBeforeMs = delayBeforeMs
  }
}

/// AppKit and SwiftUI keep a mouse-down under track long enough to tell a click from a
/// drag, and a mouse-up posted in the same event tick as its mouse-down is never
/// delivered to the app. Measured on an `NSButton`: a 0 ms hold delivered 0 of 15
/// mouse-ups and activated 0 actions, 20 ms activated 14 of 15, and 40 ms and above
/// activated 15 of 15. Holds shorter than this are raised to it.
public let minimumMouseClickHoldMs = 40

/// Hold used when the caller does not name one. Comfortably above
/// `minimumMouseClickHoldMs` so a press does not sit on the measured cliff.
public let defaultMouseClickHoldMs = 60

public func mouseClickHoldMs(requestedMs: Int) -> Int {
  if requestedMs <= 0 {
    return defaultMouseClickHoldMs
  }
  return max(requestedMs, minimumMouseClickHoldMs)
}

/// The event schedule one synthetic click becomes: park the cursor, then press and
/// release, repeating for multi-clicks. Every `up` is separated from its `down`, which
/// is what makes the release reach the app at all.
public func mouseClickSteps(holdMs: Int, clicks: Int, intervalMs: Int) -> [MouseClickStep] {
  let hold = mouseClickHoldMs(requestedMs: holdMs)
  let gap = max(intervalMs, 0)
  var steps: [MouseClickStep] = [MouseClickStep(kind: .move, delayBeforeMs: 0)]
  for index in 0..<max(clicks, 1) {
    steps.append(MouseClickStep(kind: .down, delayBeforeMs: index == 0 ? 0 : gap))
    steps.append(MouseClickStep(kind: .up, delayBeforeMs: hold))
  }
  return steps
}
