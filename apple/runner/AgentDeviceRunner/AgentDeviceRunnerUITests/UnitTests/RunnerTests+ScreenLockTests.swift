import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS) && targetEnvironment(simulator)
extension RunnerTests {
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
    var reads = [false, false, true]
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
}
#endif
