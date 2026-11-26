import XCTest

/// Runner state only the main thread reads or writes. Off-main code reads target identity from a
/// `SnapshotCaptureTarget` taken on main and writes through `applyMainOwnedSnapshotState`.
@MainActor
final class RunnerMainOwnedState {
  var app: XCUIApplication?
  var bundleId: String?
  var processIdentifier: Int?
  var accessibilityHealth: RunnerAccessibilityHealth = .unknown
  /// When the first interaction after an XCTest snapshot may run. The guarantee is a minimum gap
  /// *since the snapshot finished*, not a pause at the interaction: a caller that already spent
  /// that gap elsewhere has satisfied it and waits for nothing. `nil` = no snapshot is pending
  /// stabilization.
  var postSnapshotInteractionReadyUptime: TimeInterval?
  /// The device's only screen in portrait points, kept for the rest of the command after its first
  /// successful read. Each command reads it again, because display scaling can change it while the
  /// runner runs; orientation is applied per gesture.
  var soleDisplayPortraitSize: CGSize?

  nonisolated init() {}
}

/// The runner's one entry into main-actor isolation from code that is on the main thread without
/// being statically isolated: the main hops of `runMainThreadWork` and `applyMainOwnedSnapshotState`,
/// and the blocks XCTest calls back. `MainActor.assumeIsolated` traps when the caller is off main.
/// It returns only `Sendable` values, so the result leaves through a captured `Result`: a
/// `T: Sendable` bound would promise something no gate checks.
func runOnMainActor<T>(_ work: @MainActor () throws -> T) -> Result<T, Error> {
  var result: Result<T, Error>?
  MainActor.assumeIsolated {
    result = Result { try work() }
  }
  return result!
}
