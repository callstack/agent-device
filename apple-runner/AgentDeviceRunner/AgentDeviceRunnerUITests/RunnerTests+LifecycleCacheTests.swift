import XCTest

extension RunnerTests {
  func testCachedTargetRefreshRequiresChangedPositiveProcessIdentity() {
    XCTAssertFalse(
      Self.shouldRefreshCachedTarget(
        cachedProcessIdentifier: nil,
        observedProcessIdentifier: 42
      )
    )
    XCTAssertFalse(
      Self.shouldRefreshCachedTarget(
        cachedProcessIdentifier: 42,
        observedProcessIdentifier: 42
      )
    )
    XCTAssertTrue(
      Self.shouldRefreshCachedTarget(
        cachedProcessIdentifier: 41,
        observedProcessIdentifier: 42
      )
    )
  }

  func testSnapshotPenaltyWarmupExemptionIsConsumedOnce() {
    snapshotXCTestPenaltyWarmupExemptionPending = true

    XCTAssertTrue(consumeSnapshotXCTestPenaltyWarmupExemption())
    XCTAssertFalse(consumeSnapshotXCTestPenaltyWarmupExemption())
  }

  func testSnapshotPenaltyCanBeClearedAcrossTargetProcessReplacement() {
    penalizeSnapshotXCTestChannel(bundleId: "com.example.app", reason: "test")
    XCTAssertTrue(isSnapshotXCTestChannelPenalized(bundleId: "com.example.app"))

    clearSnapshotXCTestChannelPenalty(reason: "target_process_changed")

    XCTAssertFalse(isSnapshotXCTestChannelPenalized(bundleId: "com.example.app"))
  }
}
