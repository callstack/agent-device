import CoreGraphics
import Foundation

/// One node of a modal-scope tree read. `element` is the node's AX identity. One element can
/// appear under two parents in one tree, so a node is the pair (`element`, `parentElement`).
public struct ModalScopeNode: Equatable {
  public let element: String
  public let parentElement: String?
  public let frame: CGRect

  public init(element: String, parentElement: String?, frame: CGRect) {
    self.element = element
    self.parentElement = parentElement
    self.frame = frame
  }
}

/// Why a plain read and an honor-modal read of one app cannot be compared.
public enum ModalScopeInstability: String, Equatable {
  /// A cap clipped one of the reads.
  case truncated
  /// The honor-modal reads before and after the plain read differ, so the screen changed.
  case screenChanged
  /// The honor-modal read has an element the plain read does not.
  case unmatchedElement
  /// The honor-modal read has an element under a parent the plain read does not put it under.
  case reparentedElement
  /// An element has a different frame in the two reads, so the screen changed between them.
  case movedElement
}

public enum ModalScopePairing: Equatable {
  /// The honor-modal read is the plain read without `removedNodeCount` nodes.
  case paired(removedNodeCount: Int)
  case unstable(ModalScopeInstability)
}

public enum ModalScopePair {
  /// Matches each honor-modal node to a plain node by element and parent element. The honor-modal
  /// read of a still screen is a subset of the plain read, so any other result means the reads saw
  /// different screens. A subset alone does not prove a still screen: a modal dismissed between
  /// the reads leaves the honor-modal read a subset too, so `confirmingHonorModal`, read after the
  /// plain read, must equal `honorModal`.
  public static func pair(
    plain: [ModalScopeNode],
    honorModal: [ModalScopeNode],
    confirmingHonorModal: [ModalScopeNode]
  ) -> ModalScopePairing {
    guard honorModal == confirmingHonorModal else { return .unstable(.screenChanged) }
    struct Key: Hashable {
      let element: String
      let parentElement: String?
    }
    var unmatched: [Key: (frame: CGRect, count: Int)] = [:]
    var plainElements = Set<String>()
    for node in plain {
      let key = Key(element: node.element, parentElement: node.parentElement)
      unmatched[key] = (node.frame, (unmatched[key]?.count ?? 0) + 1)
      plainElements.insert(node.element)
    }
    for node in honorModal {
      let key = Key(element: node.element, parentElement: node.parentElement)
      guard let match = unmatched[key], match.count > 0 else {
        return .unstable(plainElements.contains(node.element) ? .reparentedElement : .unmatchedElement)
      }
      guard match.frame == node.frame else { return .unstable(.movedElement) }
      unmatched[key] = (match.frame, match.count - 1)
    }
    return .paired(removedNodeCount: plain.count - honorModal.count)
  }
}
