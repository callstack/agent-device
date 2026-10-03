import Foundation

/// AppKit and SwiftUI keep a mouse-down under track long enough to tell a click from a
/// drag, and a mouse-up posted in the same event tick as its mouse-down is never
/// delivered to the app. Measured on an `NSButton`: a 0 ms hold delivered 0 of 15
/// mouse-ups and activated 0 actions, 20 ms activated 14 of 15, and 40 ms and above
/// activated 15 of 15. Holds shorter than this are raised to it.
public let minimumMouseClickHoldMs = 40

/// Hold used when the caller does not name one. Comfortably above
/// `minimumMouseClickHoldMs` so a press does not sit on the measured cliff.
public let defaultMouseClickHoldMs = 60

/// The gap between the two presses of one double-click. Well inside the system
/// double-click interval (500 ms by default), and independent of the caller's repeat
/// interval, which separates whole presses rather than the halves of one.
public let mouseClickPairGapMs = 80

public func mouseClickHoldMs(requestedMs: Int) -> Int {
  if requestedMs <= 0 {
    return defaultMouseClickHoldMs
  }
  return max(requestedMs, minimumMouseClickHoldMs)
}

/// One press of the button: the click state it is posted with, and how long after the
/// previous release it starts.
public struct MouseClickPress: Equatable, Sendable {
  /// `1` for an independent click; `2` for the second half of a double-click.
  public let clickState: Int
  public let delayBeforeMs: Int

  public init(clickState: Int, delayBeforeMs: Int) {
    self.clickState = clickState
    self.delayBeforeMs = delayBeforeMs
  }
}

/// The presses one request becomes. `clicks` is always a count of independent presses at
/// click state 1, which is what every other platform means by `--count`; only
/// `doubleClick` raises the state, and it does so per press, so `doubleClick` with three
/// clicks is three double-clicks rather than one triple-click.
public func mouseClickPresses(clicks: Int, doubleClick: Bool, intervalMs: Int) -> [MouseClickPress] {
  let gap = max(intervalMs, 0)
  var presses: [MouseClickPress] = []
  for index in 0..<max(clicks, 1) {
    presses.append(MouseClickPress(clickState: 1, delayBeforeMs: index == 0 ? 0 : gap))
    if doubleClick {
      presses.append(MouseClickPress(clickState: 2, delayBeforeMs: mouseClickPairGapMs))
    }
  }
  return presses
}

/// How long the schedule keeps the helper busy: every hold plus every gap. The caller's
/// process timeout must cover this, or the helper is killed mid-schedule.
public func mouseClickScheduleMs(holdMs: Int, clicks: Int, doubleClick: Bool, intervalMs: Int) -> Int {
  let hold = mouseClickHoldMs(requestedMs: holdMs)
  return mouseClickPresses(clicks: clicks, doubleClick: doubleClick, intervalMs: intervalMs)
    .reduce(0) { $0 + $1.delayBeforeMs + hold }
}
