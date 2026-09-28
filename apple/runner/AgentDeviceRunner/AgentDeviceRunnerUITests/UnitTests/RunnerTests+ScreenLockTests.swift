import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS) && targetEnvironment(simulator)
extension RunnerTests {
  func testScreenLockStartsVerificationWindowAfterDispatchReturns() {
    var dispatchStarted = false
    var verificationWindowStarted = false
    var reads = 0
    let response = executeScreenLockTransition(
      readState: {
        reads += 1
        return .success(reads > 1)
      },
      dispatch: {
        dispatchStarted = true
        return nil
      },
      verifyVisibleSurface: { true },
      shouldContinue: { dispatchStarted && verificationWindowStarted },
      wait: {},
      startVerificationWindow: { verificationWindowStarted = dispatchStarted }
    )

    XCTAssertTrue(response.ok)
    XCTAssertTrue(verificationWindowStarted)
    XCTAssertEqual(reads, 3)
  }

  func testScreenLockReportsSuccessOnlyForLockScreenSpecificSurface() {
    defer { unlockSimulatorScreenIfNeeded() }

    let response = executeScreenLockCommand()

    XCTAssertTrue(response.ok, response.error?.message ?? "Expected verified screen lock")
    XCTAssertEqual(response.data?.state, "locked")
    let dateView = springboard.descendants(matching: .any)
      .matching(identifier: "lockscreen-date-view")
      .firstMatch
    let coverSheet = springboard.windows.matching(identifier: "SBCoverSheetWindow").firstMatch
    XCTAssertTrue(
      (dateView.exists && !dateView.frame.isEmpty)
        || (coverSheet.exists && !coverSheet.frame.isEmpty),
      springboard.debugDescription
    )
  }

  func testScreenLockIsIdempotentWhenAlreadyLocked() {
    var dispatches = 0
    let response = executeScreenLockTransition(
      readState: { .success(true) },
      dispatch: {
        dispatches += 1
        return nil
      },
      verifyVisibleSurface: { true },
      shouldContinue: { false },
      wait: {}
    )
    XCTAssertTrue(response.ok)
    XCTAssertEqual(response.data?.state, "locked")
    XCTAssertEqual(dispatches, 0)
  }

  func testScreenLockWaitsForTheVerifiedTransition() {
    var reads = [false, false, true, true]
    var dispatches = 0
    var waits = 0
    let response = executeScreenLockTransition(
      readState: { .success(reads.removeFirst()) },
      dispatch: {
        dispatches += 1
        return nil
      },
      verifyVisibleSurface: { true },
      shouldContinue: { !reads.isEmpty },
      wait: { waits += 1 }
    )
    XCTAssertTrue(response.ok)
    XCTAssertEqual(dispatches, 1)
    XCTAssertEqual(waits, 1)
  }

  func testScreenLockPropagatesUnavailableHidWithoutPolling() {
    var polled = false
    let response = executeScreenLockTransition(
      readState: { .success(false) },
      dispatch: {
        Response(
          ok: false,
          error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: "HID unavailable")
        )
      },
      verifyVisibleSurface: { true },
      shouldContinue: {
        polled = true
        return true
      },
      wait: {}
    )
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "UNSUPPORTED_OPERATION")
    XCTAssertFalse(polled)
  }

  func testScreenLockRejectsAnUnverifiedVisibleSurface() {
    let response = executeScreenLockTransition(
      readState: { .success(true) },
      dispatch: { nil },
      verifyVisibleSurface: { false },
      shouldContinue: { false },
      wait: {}
    )
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "COMMAND_FAILED")
    XCTAssertTrue(response.error?.message.contains("not visible") == true)
  }

  func testScreenLockWaitsForVisibleSurfaceAfterLockStateChanges() {
    var visible = false
    var waits = 0
    let response = executeScreenLockTransition(
      readState: { .success(true) },
      dispatch: { nil },
      verifyVisibleSurface: {
        visible = waits > 0
        return visible
      },
      shouldContinue: { waits < 1 },
      wait: { waits += 1 }
    )
    XCTAssertTrue(response.ok)
    XCTAssertEqual(waits, 1)
  }

  func testScreenLockDoesNotReportSuccessIfTheDeviceUnlocksDuringSurfaceVerification() {
    var states = [true, false]
    var waits = 0
    let response = executeScreenLockTransition(
      readState: { .success(states.removeFirst()) },
      dispatch: { nil },
      verifyVisibleSurface: { false },
      shouldContinue: { true },
      wait: { waits += 1 }
    )
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "COMMAND_FAILED")
    XCTAssertTrue(response.error?.message.contains("no longer reports") == true)
    XCTAssertEqual(waits, 0)
  }

  func testScreenLockTimesOutWhileSimulatorIsStillBooting() {
    var dispatches = 0
    let response = executeScreenLockTransition(
      readState: { .success(false) },
      dispatch: {
        dispatches += 1
        return nil
      },
      verifyVisibleSurface: { true },
      shouldContinue: { false },
      wait: {}
    )
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "COMMAND_FAILED")
    XCTAssertEqual(dispatches, 1)
  }

  func testScreenLockPerformsFinalReadAfterDeadline() {
    var reads = 0
    let response = executeScreenLockTransition(
      readState: {
        reads += 1
        return .success(reads >= 3)
      },
      dispatch: { nil },
      verifyVisibleSurface: { true },
      shouldContinue: { reads < 2 },
      wait: {}
    )
    XCTAssertTrue(response.ok)
    XCTAssertEqual(reads, 4)
  }

  func testScreenLockPropagatesLockStateReadFailure() {
    let failure = Response(
      ok: false,
      error: ErrorPayload(code: "COMMAND_FAILED", message: "notify failure")
    )
    let response = executeScreenLockTransition(
      readState: { .failure(failure) },
      dispatch: { nil },
      verifyVisibleSurface: { true },
      shouldContinue: { true },
      wait: {}
    )
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.message, "notify failure")
  }

  private func unlockSimulatorScreenIfNeeded() {
    guard case .success(true) = currentScreenLockState() else { return }

    // XCTest's simulator app launch path wakes the Lock Screen without requiring test-only
    // passcode or biometric setup. Use the built-in Settings app so cleanup is independent of the
    // optional Agent Device Tester fixture.
    XCUIApplication(bundleIdentifier: "com.apple.Preferences").launch()
    if case .success(false) = currentScreenLockState() { return }

    let start = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
    let end = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
    start.press(forDuration: 0.1, thenDragTo: end)

    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline {
      if case .success(false) = currentScreenLockState() { return }
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    XCTFail("The screen-lock integration test could not restore the Simulator to unlocked state")
  }
}
#endif
