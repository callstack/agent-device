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
  /// The honor-modal read does not start at the plain read's root.
  case rootMismatch
  /// A node lists one element as two or more of its children, and the honor-modal read keeps some
  /// of them but not all. A kept occurrence can be any of them, so the walk cannot tell which
  /// subtree lost children. When it keeps them all, they pair in order.
  case duplicatedChild
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
    // An empty honor-modal read also reports `rootMismatch`. That is only a label: the result is
    // unknown either way.
    guard plain.first?.element == honorModal.first?.element else { return .unknown(.rootMismatch) }
    guard let plainChildren = children(of: plain), let honorModalChildren = children(of: honorModal)
    else { return .unknown(.unorderedRead) }

    // Pairing matched elements under parent elements. This walk matches them under the parent node,
    // which also tells apart the occurrences of an element that one read lists under two parents.
    // An element listed more than once under one parent pairs in order when the honor-modal read keeps
    // every occurrence, and counts as removed when it keeps none. When it keeps some but not all, the
    // walk reports `duplicatedChild`.
    var failure = ModalSurfaceUnknownReason.unstable(.reparentedElement)
    func surfaces(honorModalNode: Int, plainNode: Int) -> [ModalSurface]? {
      var removed = plainChildren[plainNode]
      var kept: [(honorModal: Int, plain: Int)] = []
      let listed = occurrences(of: plainChildren[plainNode], in: plain)
      let keptListed = occurrences(of: honorModalChildren[honorModalNode], in: honorModal)
      for child in honorModalChildren[honorModalNode] {
        let element = honorModal[child].element
        let listedCount = listed[element, default: 0]
        guard listedCount < 2 || keptListed[element, default: 0] >= listedCount else {
          failure = .duplicatedChild
          return nil
        }
        guard let match = removed.firstIndex(where: { plain[$0].element == element }) else { return nil }
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

    guard let found = surfaces(honorModalNode: 0, plainNode: 0) else { return .unknown(failure) }
    return found.isEmpty ? .unknown(.noSurvivingSurface) : .modal(found)
  }

  /// The actions under a surface root, in preorder. A keyboard's controls are not part of the modal,
  /// so they offer none. The input assistant also hosts the app's own bar buttons, so it ends the
  /// keyboard's claim on its subtree.
  public static func actions(in root: AlertSurfaceNode) -> [AlertSurfaceNode] {
    actions(in: root, keyboardOwned: false)
  }

  private static func actions(in node: AlertSurfaceNode, keyboardOwned: Bool) -> [AlertSurfaceNode] {
    let keyboardOwned = SnapshotKeyboardSurface.isInputAssistant(type: node.type, identifier: node.identifier)
      ? false
      : keyboardOwned || SnapshotKeyboardSurface.isKeyboardOrKey(type: node.type)
    let isAction = !keyboardOwned
      && (AlertSurface.actionableTypes.contains(node.type)
        || AlertSurface.isDismissPopupMarker(node.label) || AlertSurface.isDismissPopupMarker(node.identifier))
    return (isAction ? [node] : []) + node.children.flatMap { actions(in: $0, keyboardOwned: keyboardOwned) }
  }

  private static func occurrences(of positions: [Int], in nodes: [ModalScopeNode]) -> [String: Int] {
    positions.reduce(into: [:]) { counts, position in counts[nodes[position].element, default: 0] += 1 }
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
