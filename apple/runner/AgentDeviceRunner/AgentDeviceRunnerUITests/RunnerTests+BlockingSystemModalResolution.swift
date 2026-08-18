import XCTest

extension RunnerTests {
  struct ResolvedBlockingSystemModal {
    let root: XCUIElement
    let ownerApp: XCUIApplication
    let actions: [XCUIElement]
  }

  enum BlockingSystemModalResolution {
    case absent
    case unresolved
    case resolved(ResolvedBlockingSystemModal)
  }

  func resolveBlockingSystemModal(
    deadline: Date
  ) -> BlockingSystemModalResolution {
    guard Self.hasSpringBoardSystemModalHost else {
      return .absent
    }

    guard let springboardModal = firstBlockingSystemModal(
      in: springboard,
      deadline: deadline
    ) else {
      return .absent
    }

    let springboardActions = actionableElements(in: springboardModal)
    if !RemoteHostedSystemModalPolicy.shouldProbeRemoteHost(
      springboardActionCount: springboardActions.count
    ) {
      return .resolved(
        ResolvedBlockingSystemModal(
          root: springboardModal,
          ownerApp: springboard,
          actions: springboardActions
        )
      )
    }

    guard Date() < deadline, let remoteModal = remoteHostedSystemModal(deadline: deadline) else {
      return .unresolved
    }
    return .resolved(remoteModal)
  }

  // AccessorySetupUI mirrors into SpringBoard, but its mirrored elements are not
  // reliably hittable. Query the host directly; activating it breaks the picker.
  private static let remoteSystemModalHostBundleIds = [
    "com.apple.AccessorySetupUI"
  ]

  private func remoteHostedSystemModal(deadline: Date) -> ResolvedBlockingSystemModal? {
    for bundleId in Self.remoteSystemModalHostBundleIds {
      guard Date() < deadline else { return nil }
      let host = XCUIApplication(bundleIdentifier: bundleId)
      let state = safely("REMOTE_MODAL_STATE", XCUIApplication.State.unknown) { host.state }
      guard RemoteHostedSystemModalPolicy.isEligibleHostState(state) else { continue }
      guard Date() < deadline else { return nil }

      // A dismissed remote host can raise kAXErrorServerNotFound. The safe queries
      // inside actionableElements turn that disappearance into an empty result.
      let actions = actionableElements(in: host)
      guard !actions.isEmpty else { continue }
      return ResolvedBlockingSystemModal(root: host, ownerApp: host, actions: actions)
    }
    return nil
  }
}

enum RemoteHostedSystemModalPolicy {
  static func shouldProbeRemoteHost(springboardActionCount: Int) -> Bool {
    springboardActionCount == 0
  }

  static func isEligibleHostState(_ state: XCUIApplication.State) -> Bool {
    state == .runningForeground
  }
}

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
