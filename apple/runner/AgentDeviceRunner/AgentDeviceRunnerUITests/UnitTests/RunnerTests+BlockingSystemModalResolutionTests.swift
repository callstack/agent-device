import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testRemoteHostProbeRunsOnlyWhenSpringboardModalHasNoActions() {
    XCTAssertTrue(RemoteHostedSystemModalPolicy.shouldProbeRemoteHost(springboardActionCount: 0))
    XCTAssertFalse(RemoteHostedSystemModalPolicy.shouldProbeRemoteHost(springboardActionCount: 1))
    XCTAssertFalse(RemoteHostedSystemModalPolicy.shouldProbeRemoteHost(springboardActionCount: 3))
  }

  func testRemoteHostStateGateFailsClosedToForeground() {
    XCTAssertTrue(RemoteHostedSystemModalPolicy.isEligibleHostState(.runningForeground))
    XCTAssertFalse(RemoteHostedSystemModalPolicy.isEligibleHostState(.runningBackground))
    XCTAssertFalse(RemoteHostedSystemModalPolicy.isEligibleHostState(.notRunning))
    XCTAssertFalse(RemoteHostedSystemModalPolicy.isEligibleHostState(.unknown))
  }

  // No SpringBoard host (`hasSpringBoardSystemModalHost`) means modal resolution must return
  // `.absent` without probing com.apple.springboard (#1351). Written for tvOS, where no lane
  // ever executed it; `resolveBlockingSystemModal` takes that decision at RUNTIME off the same
  // flag on macOS, so the host lane runs the real branch on every PR.
  //
  // Its former sibling `testBlockingSystemAlertSnapshotIsNilOnTvOS` is deleted rather than
  // widened: `blockingSystemAlertSnapshot` is `#if os(macOS) return nil`, so on the only lane
  // that could run it the assertion would pin a compile-time literal — a green that no change
  // to the runner could turn red. The runtime gate it meant to cover is this test's subject,
  // and the nil it returns on macOS is the compiler's business, not a test's.
  #if os(tvOS) || os(macOS)
  func testResolveBlockingSystemModalIsAbsentWithoutSpringBoardHost() {
    guard case .absent = resolveBlockingSystemModal(deadline: .distantFuture) else {
      XCTFail("blocking system-modal resolution must be .absent without a SpringBoard host")
      return
    }
  }
  #endif
}
#endif
