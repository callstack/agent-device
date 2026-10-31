import Foundation

/// One modal surface of a modal-scope pair: the children of `host` that the honor-modal read kept
/// where it removed others. `host` and `roots` are positions in the honor-modal read.
public struct ModalSurface: Equatable {
  public let host: Int
  public let roots: [Int]

  public init(host: Int, roots: [Int]) {
    self.host = host
    self.roots = roots
  }
}

/// Why a modal-scope pair cannot name the modal surface.
public enum ModalSurfaceUnknownReason: Equatable {
  case unstable(ModalScopeInstability)
  /// A read lists a node before the parent it names, so its tree cannot be rebuilt.
  case unorderedRead
  /// The honor-modal read removed content, but no node kept a child beside the children it lost.
  case noSurvivingSurface
}

public enum ModalSurfaceReading: Equatable {
  /// The innermost modal surface of each branch. Independent surfaces stay separate.
  case modal([ModalSurface])
  /// The honor-modal read removed nothing. This does not prove that no modal is shown: a server
  /// that ignores the honor-modal parameter also removes nothing.
  case noExclusion
  case unknown(ModalSurfaceUnknownReason)
}

extension ModalSurface {
  /// Finds the modal surfaces in a plain read and an honor-modal read of one screen. `truncated`
  /// says whether a cap clipped any of the three reads.
  ///
  /// A modal can sit inside another one, so a node's kept children are a surface only when none of
  /// them holds a surface of its own. Otherwise the inner surfaces replace it, and the underlying
  /// modal's other kept children, such as its dimming view, are not part of them.
  public static func read(
    plain: [ModalScopeNode],
    honorModal: [ModalScopeNode],
    confirmingHonorModal: [ModalScopeNode],
    truncated: Bool
  ) -> ModalSurfaceReading {
    if truncated { return .unknown(.unstable(.truncated)) }
    switch ModalScopePair.pair(plain: plain, honorModal: honorModal, confirmingHonorModal: confirmingHonorModal) {
    case let .unstable(instability):
      return .unknown(.unstable(instability))
    case .paired(removedNodeCount: 0):
      return .noExclusion
    case .paired:
      break
    }
    guard let plainChildren = children(of: plain), let honorModalChildren = children(of: honorModal),
          plain.first?.element == honorModal.first?.element
    else { return .unknown(.unorderedRead) }

    // Pairing matched elements under parent elements. This walk matches them under the parent node,
    // which also tells apart the occurrences of an element that one read lists under two parents.
    func surfaces(honorModalNode: Int, plainNode: Int) -> [ModalSurface]? {
      var removed = plainChildren[plainNode]
      var kept: [(honorModal: Int, plain: Int)] = []
      for child in honorModalChildren[honorModalNode] {
        guard let match = removed.firstIndex(where: { plain[$0].element == honorModal[child].element }) else {
          return nil
        }
        kept.append((child, removed.remove(at: match)))
      }
      var nested: [ModalSurface] = []
      for child in kept {
        guard let surfaces = surfaces(honorModalNode: child.honorModal, plainNode: child.plain) else { return nil }
        nested += surfaces
      }
      guard nested.isEmpty, !removed.isEmpty, !kept.isEmpty else { return nested }
      return [ModalSurface(host: honorModalNode, roots: kept.map(\.honorModal))]
    }

    guard let found = surfaces(honorModalNode: 0, plainNode: 0) else {
      return .unknown(.unstable(.reparentedElement))
    }
    return found.isEmpty ? .unknown(.noSurvivingSurface) : .modal(found)
  }

  /// The actions under a surface root, in preorder. A keyboard and the input assistant above it are
  /// not part of the modal, so their branches offer none.
  public static func actions(in root: AlertSurfaceNode) -> [AlertSurfaceNode] {
    if SnapshotKeyboardSurface.isKeyboardBranch(type: root.type, identifier: root.identifier) { return [] }
    let isAction = AlertSurface.actionableTypes.contains(root.type)
      || AlertSurface.isDismissPopupMarker(root.label) || AlertSurface.isDismissPopupMarker(root.identifier)
    return (isAction ? [root] : []) + root.children.flatMap { actions(in: $0) }
  }

  /// Each node's children, in order. A read lists every node after its parent, so a node's parent
  /// is its nearest listed ancestor with the parent element.
  private static func children(of nodes: [ModalScopeNode]) -> [[Int]]? {
    var children = Array(repeating: [Int](), count: nodes.count)
    var ancestors: [Int] = []
    for (position, node) in nodes.enumerated() {
      if let parentElement = node.parentElement {
        while let last = ancestors.last, nodes[last].element != parentElement {
          ancestors.removeLast()
        }
        guard let parent = ancestors.last else { return nil }
        children[parent].append(position)
      } else if position != 0 {
        return nil
      }
      ancestors.append(position)
    }
    return children
  }
}
