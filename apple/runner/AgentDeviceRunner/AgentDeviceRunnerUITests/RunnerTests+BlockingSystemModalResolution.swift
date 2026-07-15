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
}
#endif
