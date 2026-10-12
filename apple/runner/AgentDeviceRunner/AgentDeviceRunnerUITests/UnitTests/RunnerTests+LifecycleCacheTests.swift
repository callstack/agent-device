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
  @MainActor
  private func withStubbedTargetActivation(_ body: () -> Void) {
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
    body()
  }

  @MainActor
  func testActivateTargetSkipsForegroundAndActivatesNonForegroundApplication() {
    withStubbedTargetActivation {
      RunnerTargetActivationSpy.state = .runningForeground
      textEntryTapWitness = TextEntryTapWitness(
        element: app,
        bundleId: "com.example.previous",
        processIdentifier: 41
      )
      // The happy path owes two things: no activation work at all, and no fact to disclose. Clearing
      // first makes the nil below a claim about THIS call rather than whatever an earlier test left.
      pendingTargetActivation = nil
      _ = activateTarget(bundleId: "com.example.foreground", reason: "unit_test")
      XCTAssertEqual(RunnerTargetActivationSpy.activationCount, 0)
      XCTAssertNil(textEntryTapWitness)
      XCTAssertNil(
        pendingTargetActivation,
        "an already-foreground command performed no repair and must stamp nothing (#2682)"
      )

      RunnerTargetActivationSpy.state = .runningBackground
      _ = activateTarget(bundleId: "com.example.background", reason: "unit_test")
      XCTAssertEqual(RunnerTargetActivationSpy.activationCount, 1)
      // The stamped state is the one read BEFORE `activate()` ran, so the fact describes what was
      // repaired. A value read after the repair would report `.runningForeground` here (#2682).
      XCTAssertEqual(
        pendingTargetActivation?.priorState,
        Int(XCUIApplication.State.runningBackground.rawValue)
      )
      XCTAssertEqual(pendingTargetActivation?.reason, "unit_test")
    }
  }

  @MainActor
  func testSkippedActivationAfterAnnouncedRelaunchKeepsAnElapsedWindow() {
    withStubbedTargetActivation {
      mainOwned.needsPostSnapshotInteractionDelay = false
      RunnerTargetActivationSpy.state = .runningForeground
      mainOwned.app = app
      mainOwned.bundleId = "com.example.app"
      _ = resetTargetAfterExternalRelaunch()
      stampElapsedWindow(origin: .announcedRelaunch(bundleId: "com.example.app"))

      _ = activateTarget(bundleId: "com.example.app", reason: "bundle_changed")

      XCTAssertEqual(RunnerTargetActivationSpy.activationCount, 0)
      XCTAssertLessThan(measureStabilizationDuration(), firstInteractionAfterActivateDelay / 2)
      XCTAssertNil(firstInteractionWindow)
    }
  }

  @MainActor
  func testSkippedActivationAfterAnnouncedRelaunchWaitsOnlyForTheRemainingWindow() {
    withStubbedTargetActivation {
      mainOwned.needsPostSnapshotInteractionDelay = false
      RunnerTargetActivationSpy.state = .runningForeground
      mainOwned.app = app
      mainOwned.bundleId = "com.example.app"
      _ = resetTargetAfterExternalRelaunch()
      let resetWindow = firstInteractionWindow
      sleepFor(firstInteractionAfterActivateDelay / 2)

      _ = activateTarget(bundleId: "com.example.app", reason: "bundle_changed")

      XCTAssertEqual(firstInteractionWindow?.readyUptime, resetWindow?.readyUptime)
      XCTAssertEqual(firstInteractionWindow?.origin, .announcedRelaunch(bundleId: "com.example.app"))
      XCTAssertLessThan(measureStabilizationDuration(), firstInteractionAfterActivateDelay * 0.75)
      XCTAssertNil(firstInteractionWindow)
    }
  }

  @MainActor
  func testAnnouncedRelaunchWithNoBoundTargetCoversWhicheverBundleActivatesNext() {
    withStubbedTargetActivation {
      mainOwned.needsPostSnapshotInteractionDelay = false
      RunnerTargetActivationSpy.state = .runningForeground
      invalidateCachedTarget(reason: "unit_test_setup")
      _ = resetTargetAfterExternalRelaunch()
      XCTAssertEqual(firstInteractionWindow?.origin, .announcedRelaunch(bundleId: nil))
      stampElapsedWindow(origin: .announcedRelaunch(bundleId: nil))

      _ = activateTarget(bundleId: "com.example.app", reason: "bundle_changed")

      XCTAssertLessThan(measureStabilizationDuration(), firstInteractionAfterActivateDelay / 2)
    }
  }

  @MainActor
  func testSkippedActivationOfAnotherBundleThanTheAnnouncedRelaunchStampsFresh() {
    withStubbedTargetActivation {
      mainOwned.needsPostSnapshotInteractionDelay = false
      RunnerTargetActivationSpy.state = .runningForeground
      stampElapsedWindow(origin: .announcedRelaunch(bundleId: "com.example.a"))

      _ = activateTarget(bundleId: "com.example.b", reason: "bundle_changed")

      XCTAssertEqual(firstInteractionWindow?.origin, .activation)
      XCTAssertGreaterThanOrEqual(
        measureStabilizationDuration(),
        firstInteractionAfterActivateDelay * 0.8
      )
    }
  }

  @MainActor
  func testStaleActivationWindowSurvivingTerminateInvalidationStampsFreshOnSkippedActivation() {
    withStubbedTargetActivation {
      mainOwned.needsPostSnapshotInteractionDelay = false
      RunnerTargetActivationSpy.state = .runningForeground
      mainOwned.app = app
      mainOwned.bundleId = "com.example.app"
      stampElapsedWindow(origin: .activation)

      invalidateCachedTarget(reason: "target_terminated")
      _ = activateTarget(bundleId: "com.example.app", reason: "bundle_changed")

      XCTAssertEqual(RunnerTargetActivationSpy.activationCount, 0)
      XCTAssertGreaterThanOrEqual(
        measureStabilizationDuration(),
        firstInteractionAfterActivateDelay * 0.8
      )
    }
  }

  @MainActor
  func testAnnouncedRelaunchWindowDoesNotSurviveALaterInvalidation() {
    withStubbedTargetActivation {
      mainOwned.needsPostSnapshotInteractionDelay = false
      RunnerTargetActivationSpy.state = .runningForeground
      mainOwned.app = app
      mainOwned.bundleId = "com.example.app"
      _ = resetTargetAfterExternalRelaunch()
      stampElapsedWindow(origin: .announcedRelaunch(bundleId: "com.example.app"))

      invalidateCachedTarget(reason: "ax_snapshot_failure")
      _ = activateTarget(bundleId: "com.example.app", reason: "bundle_changed")

      XCTAssertEqual(RunnerTargetActivationSpy.activationCount, 0)
      XCTAssertGreaterThanOrEqual(
        measureStabilizationDuration(),
        firstInteractionAfterActivateDelay * 0.8
      )
    }
  }

  @MainActor
  func testSkippedActivationWithoutAWindowStampsOne() {
    withStubbedTargetActivation {
      mainOwned.needsPostSnapshotInteractionDelay = false
      RunnerTargetActivationSpy.state = .runningForeground
      firstInteractionWindow = nil

      _ = activateTarget(bundleId: "com.example.app", reason: "bundle_changed")

      XCTAssertEqual(firstInteractionWindow?.origin, .activation)
      XCTAssertGreaterThanOrEqual(
        measureStabilizationDuration(),
        firstInteractionAfterActivateDelay * 0.8
      )
    }
  }

  @MainActor
  func testPerformedActivationReplacesAnElapsedAnnouncedWindow() {
    withStubbedTargetActivation {
      mainOwned.needsPostSnapshotInteractionDelay = false
      RunnerTargetActivationSpy.state = .runningBackground
      stampElapsedWindow(origin: .announcedRelaunch(bundleId: "com.example.app"))

      _ = activateTarget(bundleId: "com.example.app", reason: "bundle_changed")

      XCTAssertEqual(RunnerTargetActivationSpy.activationCount, 1)
      XCTAssertEqual(firstInteractionWindow?.origin, .activation)
      XCTAssertGreaterThanOrEqual(
        measureStabilizationDuration(),
        firstInteractionAfterActivateDelay * 0.8
      )
    }
  }

  @MainActor
  private func stampElapsedWindow(origin: FirstInteractionWindow.Origin) {
    firstInteractionWindow = FirstInteractionWindow(
      readyUptime: ProcessInfo.processInfo.systemUptime - 1,
      origin: origin
    )
  }
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
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
    snapshotXCTestPenaltyWarmupExemption.isPending = true

    XCTAssertTrue(snapshotXCTestPenaltyWarmupExemption.consume())
    XCTAssertFalse(snapshotXCTestPenaltyWarmupExemption.consume())
  }

  func testSnapshotPenaltyCanBeClearedAcrossTargetProcessReplacement() {
    penalizeSnapshotXCTestChannel(bundleId: "com.example.app", reason: "test")
    XCTAssertTrue(isSnapshotXCTestChannelPenalized(bundleId: "com.example.app"))

    clearSnapshotXCTestChannelPenalty(reason: "target_process_changed")

    XCTAssertFalse(isSnapshotXCTestChannelPenalized(bundleId: "com.example.app"))
  }

  @MainActor
  func testCachedTargetInvalidationClearsProcessBoundState() {
    mainOwned.app = app
    mainOwned.bundleId = "com.example.app"
    mainOwned.processIdentifier = 42
    snapshotXCTestPenaltyWarmupExemption.isPending = true

    invalidateCachedTarget(reason: "unit_test")

    XCTAssertNil(mainOwned.app)
    XCTAssertNil(mainOwned.bundleId)
    XCTAssertNil(mainOwned.processIdentifier)
    XCTAssertFalse(snapshotXCTestPenaltyWarmupExemption.isPending)
  }

  func testTextEntryTapWitnessIsBoundToTargetIdentity() {
    let witness = TextEntryTapWitness(
      element: app,
      bundleId: "com.example.app",
      processIdentifier: 42
    )

    XCTAssertTrue(witness.matches(bundleId: "com.example.app", processIdentifier: 42))
    XCTAssertFalse(witness.matches(bundleId: "com.example.other", processIdentifier: 42))
    XCTAssertFalse(witness.matches(bundleId: "com.example.app", processIdentifier: 43))
  }

  @MainActor
  func testTargetResetInvalidatesProcessBoundStateWithoutRestartingRunner() {
    mainOwned.app = app
    mainOwned.bundleId = "com.example.app"
    mainOwned.processIdentifier = 42
    snapshotXCTestPenaltyWarmupExemption.isPending = true
    firstInteractionWindow = nil
    penalizeSnapshotXCTestChannel(bundleId: "com.example.app", reason: "test")
    XCTAssertTrue(isSnapshotXCTestChannelPenalized(bundleId: "com.example.app"))

    let response = resetTargetAfterExternalRelaunch()

    XCTAssertTrue(response.ok)
    XCTAssertNil(mainOwned.app)
    XCTAssertNil(mainOwned.bundleId)
    XCTAssertNil(mainOwned.processIdentifier)
    XCTAssertFalse(snapshotXCTestPenaltyWarmupExemption.isPending)
    XCTAssertFalse(isSnapshotXCTestChannelPenalized(bundleId: "com.example.app"))
    XCTAssertEqual(firstInteractionWindow?.origin, .announcedRelaunch(bundleId: "com.example.app"))
  }

  /// The settling window is a deadline measured from the activation, not a pause charged at the
  /// interaction. A caller that already spent the window elsewhere waits for nothing; one that
  /// arrives immediately still waits. Without the deadline both cases sleep the full delay.
  @MainActor
  func testFirstInteractionStabilizationWaitsOnlyForTheRemainderOfTheWindow() {
    mainOwned.needsPostSnapshotInteractionDelay = false

    // An activation whose window has already elapsed: the caller spent it getting back to us.
    firstInteractionWindow = FirstInteractionWindow(
      readyUptime: ProcessInfo.processInfo.systemUptime - 1,
      origin: .activation
    )
    let elapsedAfterSatisfiedWindow = measureStabilizationDuration()
    XCTAssertLessThan(elapsedAfterSatisfiedWindow, firstInteractionAfterActivateDelay / 2)
    XCTAssertNil(firstInteractionWindow)

    // A fresh activation still gets the whole guard.
    beginFirstInteractionStabilization()
    let elapsedAfterFreshActivation = measureStabilizationDuration()
    XCTAssertGreaterThanOrEqual(
      elapsedAfterFreshActivation,
      firstInteractionAfterActivateDelay * 0.8
    )
    XCTAssertNil(firstInteractionWindow)
  }

  @MainActor
  private func measureStabilizationDuration() -> TimeInterval {
    let startedAt = ProcessInfo.processInfo.systemUptime
    applyInteractionStabilizationIfNeeded()
    return ProcessInfo.processInfo.systemUptime - startedAt
  }
#endif
}
