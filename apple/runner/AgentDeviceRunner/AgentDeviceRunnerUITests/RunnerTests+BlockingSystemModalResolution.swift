import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  func resolveBlockingSystemModal(deadline: Date) -> AlertResolution {
    guard Self.hasSpringBoardSystemModalHost else { return .absent }
    do {
      guard let modal = try firstBlockingSystemModal(in: springboard, deadline: deadline) else {
        return .absent
      }
      let actions = try readModalActions(in: modal.root, deadline: deadline)
      if RemoteHostedSystemModalPolicy.shouldProbeRemoteHost(springboardActionCount: actions.count) {
        guard let remote = try remoteHostedSystemModal(deadline: deadline) else { return .unresolved }
        return .resolved(remote)
      }
      return .resolved(RunnerAlert(
        root: modal.root, ownerApp: springboard, actions: actions,
        source: .blockingSystemModal, window: modal.window
      ))
    } catch {
      if case ModalReadFailure.deadlineExceeded = error {
        NSLog("AGENT_DEVICE_RUNNER_SYSTEM_MODAL_PROBE_DEADLINE stage=required-read")
      }
      return .unresolved
    }
  }

  // AccessorySetupUI mirrors into SpringBoard, but its mirrored elements are not
  // reliably hittable. Query the host directly; activating it breaks the picker.
  private static let remoteSystemModalHostBundleIds = [
    "com.apple.AccessorySetupUI"
  ]

  private func remoteHostedSystemModal(deadline: Date) throws -> RunnerAlert? {
    for bundleId in Self.remoteSystemModalHostBundleIds {
      let host = XCUIApplication(bundleIdentifier: bundleId)
      let state = try readModalValue(deadline: deadline) { host.state }
      guard RemoteHostedSystemModalPolicy.isEligibleHostState(state) else { continue }

      let actions = try readModalActions(in: host, deadline: deadline)
      guard !actions.isEmpty else { continue }
      return RunnerAlert(
        root: host, ownerApp: host, actions: actions,
        source: .blockingSystemModal, window: nil
      )
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
