import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testSnapshotCaptureTargetKeepsPreparedIdentityAndConsumesWarmupExemptionOnce() {
    currentApp = app
    currentBundleId = "com.example.prepared"
    currentAppProcessIdentifier = 42
    snapshotXCTestPenaltyWarmupExemptionPending = true
    defer { invalidateCachedTarget(reason: "unit_test_cleanup") }

    let target = takeSnapshotCaptureTarget(app: app)
    currentBundleId = "com.example.replaced"
    currentAppProcessIdentifier = 43

    XCTAssertTrue(target.app === app)
    XCTAssertEqual(target.bundleId, "com.example.prepared")
    XCTAssertEqual(target.processIdentifier, 42)
    XCTAssertTrue(target.xCTestPenaltyWarmupExempt)
    XCTAssertFalse(
      snapshotXCTestPenaltyWarmupExemptionPending,
      "taking the target on main consumes the exemption, so the plan never touches the flag"
    )
    XCTAssertFalse(takeSnapshotCaptureTarget(app: app).xCTestPenaltyWarmupExempt)
  }

  func testMainOwnedSnapshotStateWriteRunsOnMainBeforeReturningWhenMainIsFree() {
    final class ResultBox {
      var ranOnMainThread: Bool?
      var appliedBeforeReturn: Bool?
    }
    let box = ResultBox()
    let finished = expectation(description: "off-main write returned")

    DispatchQueue(label: "agent-device.runner.tests.main-owned-snapshot-state").async {
      self.applyMainOwnedSnapshotState("unit_test") {
        box.ranOnMainThread = Thread.isMainThread
      }
      box.appliedBeforeReturn = box.ranOnMainThread != nil
      finished.fulfill()
    }

    wait(for: [finished], timeout: 3)
    XCTAssertEqual(box.ranOnMainThread, true)
    XCTAssertEqual(box.appliedBeforeReturn, true)
    XCTAssertFalse(hasAbandonedMainThreadWork())
  }
#endif
}
