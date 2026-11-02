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
  /// The device's only screen in portrait points, kept after its first successful read: a device's
  /// display size does not change while the runner runs, and orientation is applied per gesture.
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
