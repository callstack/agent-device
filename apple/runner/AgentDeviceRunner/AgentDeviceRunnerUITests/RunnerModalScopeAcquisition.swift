import XCTest
import AgentDeviceSnapshotPresentation

enum ModalScopeAcquisitionFailure: Equatable {
  case clientUnavailable
  case targetUnresolved
  case requestFailed
  case deadlineExceeded
}

/// A plain read and two honor-modal reads of one app that saw the same screen.
struct ModalScopeReads {
  let plain: RunnerAXModalScopeTree
  let honorModal: RunnerAXModalScopeTree
  let confirmingHonorModal: RunnerAXModalScopeTree
  /// Plain nodes the honor-modal read leaves out. Zero does not prove that no modal is shown: a
  /// server that ignores the honor-modal parameter also removes nothing.
  let removedNodeCount: Int
}

enum ModalScopeAcquisition {
  case paired(ModalScopeReads)
  case unsupported
  case failed(ModalScopeAcquisitionFailure)
  case unstable(ModalScopeInstability)

  static let maxDepth = 64
  static let maxNodes = 5_000

  static func acquire(of app: XCUIApplication, includeClassNames: Bool, deadline: Date) -> ModalScopeAcquisition {
    let capture = RunnerAXSnapshotBridge.modalScopeCapture(
      for: app,
      maxDepth: maxDepth,
      maxNodes: maxNodes,
      includeClassNames: includeClassNames,
      deadline: deadline
    )
    switch capture.status {
    case .captured:
      break
    case .unsupported:
      return .unsupported
    case .clientUnavailable:
      return .failed(.clientUnavailable)
    case .targetUnresolved:
      return .failed(.targetUnresolved)
    case .requestFailed:
      NSLog("AGENT_DEVICE_RUNNER_MODAL_SCOPE_REQUEST_FAILED=%@", capture.failure ?? "")
      return .failed(.requestFailed)
    case .deadlineExceeded:
      return .failed(.deadlineExceeded)
    }
    guard let plain = capture.plain, let honorModal = capture.honorModal,
          let confirmingHonorModal = capture.confirmingHonorModal
    else { return .failed(.requestFailed) }
    guard !plain.truncated, !honorModal.truncated, !confirmingHonorModal.truncated else {
      return .unstable(.truncated)
    }
    switch ModalScopePair.pair(
      plain: modalScopeNodes(plain),
      honorModal: modalScopeNodes(honorModal),
      confirmingHonorModal: modalScopeNodes(confirmingHonorModal)
    ) {
    case let .paired(removedNodeCount):
      return .paired(ModalScopeReads(
        plain: plain,
        honorModal: honorModal,
        confirmingHonorModal: confirmingHonorModal,
        removedNodeCount: removedNodeCount
      ))
    case let .unstable(instability):
      return .unstable(instability)
    }
  }

  private static func modalScopeNodes(_ tree: RunnerAXModalScopeTree) -> [ModalScopeNode] {
    tree.nodes.map { ModalScopeNode(element: $0.element, parentElement: $0.parentElement, frame: $0.frame) }
  }
}
