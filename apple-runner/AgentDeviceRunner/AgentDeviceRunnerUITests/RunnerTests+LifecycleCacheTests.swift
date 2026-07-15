import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

private enum RunnerTargetActivationSpy {
  static var state: XCUIApplication.State = .unknown
  static var activationCount = 0
}

private final class RunnerTargetActivationStub: NSObject {
  @objc var state: XCUIApplication.State {
    RunnerTargetActivationSpy.state
  }

  @objc func activate() {
    RunnerTargetActivationSpy.activationCount += 1
  }
}
#endif

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  func testActivateTargetSkipsForegroundAndActivatesNonForegroundApplication() {
    let stateSelector = #selector(getter: XCUIApplication.state)
    let activateSelector = #selector(XCUIApplication.activate)
    guard
      let stateMethod = class_getInstanceMethod(XCUIApplication.self, stateSelector),
      let stateStubMethod = class_getInstanceMethod(RunnerTargetActivationStub.self, stateSelector),
      let activateMethod = class_getInstanceMethod(XCUIApplication.self, activateSelector),
      let activateStubMethod = class_getInstanceMethod(
        RunnerTargetActivationStub.self,
        activateSelector
      )
    else {
      return XCTFail("unable to install target activation spy")
    }
    let originalStateImplementation = method_getImplementation(stateMethod)
    let originalActivateImplementation = method_getImplementation(activateMethod)
    method_setImplementation(stateMethod, method_getImplementation(stateStubMethod))
    method_setImplementation(activateMethod, method_getImplementation(activateStubMethod))
    RunnerTargetActivationSpy.activationCount = 0
    defer {
      method_setImplementation(stateMethod, originalStateImplementation)
      method_setImplementation(activateMethod, originalActivateImplementation)
      RunnerTargetActivationSpy.state = .unknown
      RunnerTargetActivationSpy.activationCount = 0
      invalidateCachedTarget(reason: "unit_test_cleanup")
    }

    RunnerTargetActivationSpy.state = .runningForeground
    _ = activateTarget(bundleId: "com.example.foreground", reason: "unit_test")
    XCTAssertEqual(RunnerTargetActivationSpy.activationCount, 0)

    RunnerTargetActivationSpy.state = .runningBackground
    _ = activateTarget(bundleId: "com.example.background", reason: "unit_test")
    XCTAssertEqual(RunnerTargetActivationSpy.activationCount, 1)
  }
#endif

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

  func testCachedTargetInvalidationClearsProcessBoundState() {
    currentApp = app
    currentBundleId = "com.example.app"
    currentAppProcessIdentifier = 42
    snapshotXCTestPenaltyWarmupExemptionPending = true

    invalidateCachedTarget(reason: "unit_test")

    XCTAssertNil(currentApp)
    XCTAssertNil(currentBundleId)
    XCTAssertNil(currentAppProcessIdentifier)
    XCTAssertFalse(snapshotXCTestPenaltyWarmupExemptionPending)
  }
}
