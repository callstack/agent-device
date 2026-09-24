import XCTest

/// Runner state only the main thread reads or writes. Off-main code reads target identity from a
/// `SnapshotCaptureTarget` taken on main and writes through `applyMainOwnedSnapshotState`.
@MainActor
final class RunnerMainOwnedState {
  var app: XCUIApplication?
  var bundleId: String?
  var processIdentifier: Int?
  var accessibilityHealth: RunnerAccessibilityHealth = .unknown
  var needsPostSnapshotInteractionDelay = false

  nonisolated init() {}
}
