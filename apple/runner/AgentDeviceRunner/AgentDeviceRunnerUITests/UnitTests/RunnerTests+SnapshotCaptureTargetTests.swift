import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  @MainActor
  func testSnapshotCaptureTargetKeepsPreparedIdentityAndLeavesWarmupExemptionPending() {
    mainOwned.app = app
    mainOwned.bundleId = "com.example.prepared"
    mainOwned.processIdentifier = 42
    snapshotXCTestPenaltyWarmupExemption.isPending = true
    defer { invalidateCachedTarget(reason: "unit_test_cleanup") }

    let target = takeSnapshotCaptureTarget(app: app)
    mainOwned.bundleId = "com.example.replaced"
    mainOwned.processIdentifier = 43

    XCTAssertTrue(target.app === app)
    XCTAssertEqual(target.bundleId, "com.example.prepared")
    XCTAssertEqual(target.processIdentifier, 42)
    XCTAssertTrue(
      snapshotXCTestPenaltyWarmupExemption.isPending,
      "only a capture plan that runs may spend the exemption"
    )
  }

#if os(iOS)
  @MainActor
  func testBlockingModalSnapshotLeavesWarmupExemptionForTheFirstCapturePlan() throws {
    mainOwned.app = app
    mainOwned.bundleId = "com.example.fresh-process"
    mainOwned.processIdentifier = 42
    snapshotXCTestPenaltyWarmupExemption.isPending = true
    systemModalProbeOverrideForTesting = { _ in DataPayload(message: "blocking system modal") }
    defer {
      systemModalProbeOverrideForTesting = nil
      mainOwned.accessibilityHealth = .unknown
      invalidateCachedTarget(reason: "unit_test_cleanup")
    }
    let options = PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false)

    let fast = try snapshotFast(target: takeSnapshotCaptureTarget(app: app), options: options)
    let raw = try snapshotRaw(target: takeSnapshotCaptureTarget(app: app), options: options)

    XCTAssertEqual(fast.message, "blocking system modal")
    XCTAssertEqual(raw.message, "blocking system modal")
    XCTAssertTrue(
      snapshotXCTestPenaltyWarmupExemption.isPending,
      "a snapshot answered by the modal probe runs no capture plan, so the exemption stays pending"
    )

    _ = try runSnapshotCapturePlan(
      [],
      target: takeSnapshotCaptureTarget(app: app),
      options: options,
      terminal: .sparseWithFatalOnAXFailure
    )

    XCTAssertFalse(
      snapshotXCTestPenaltyWarmupExemption.isPending,
      "the first capture plan that runs spends the exemption"
    )
  }
#endif

  func testProbePenaltyIdentityTakesTheIdentityItsCallerMayLegallyKnow() {
    let prepared = SnapshotProbePenaltyIdentity(.prepared(bundleId: "com.example.prepared"))
    prepared.captureFromMain(bundleId: "com.example.settled")
    XCTAssertEqual(
      prepared.penalizedBundleId,
      "com.example.prepared",
      "a capture penalizes the target it was prepared for, whatever lifecycle binds meanwhile"
    )

    let mainOwned = SnapshotProbePenaltyIdentity(.mainOwnedTarget)
    XCTAssertNil(
      mainOwned.penalizedBundleId,
      "a command-queue caller knows no identity until the probe's main-side block runs"
    )
    mainOwned.captureFromMain(bundleId: "com.example.settled")
    XCTAssertEqual(mainOwned.penalizedBundleId, "com.example.settled")
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
