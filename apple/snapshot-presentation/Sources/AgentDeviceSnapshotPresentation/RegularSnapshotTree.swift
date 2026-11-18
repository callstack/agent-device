import CoreGraphics

/// Duplicate handling for the runner's regular XCTest tree walk.
public struct RegularSnapshotTree {
  public enum Policy: String, Decodable {
    case fullBounds
    case originOnly
    case tvOS

    public static var platformDefault: Self {
      #if os(iOS)
        return .fullBounds
      #elseif os(tvOS)
        return .tvOS
      #else
        return .originOnly
      #endif
    }

    public func identity(elementType: String, label: String, identifier: String, frame: CGRect) -> String {
      let originIdentity = "\(elementType)-\(label)-\(identifier)-\(frame.origin.x)-\(frame.origin.y)"
      if self == .fullBounds {
        return "\(originIdentity)-\(frame.width)-\(frame.height)"
      }
      return originIdentity
    }
  }

  private let policy: Policy
  private var firstIndexByIdentity: [String: Int] = [:]

  public init(policy: Policy) {
    self.policy = policy
  }

  /// Appends an admitted node. Children of a rejected duplicate retain the duplicate's parent.
  public mutating func append(_ node: RawAXNode, elementType: String, to nodes: inout [RawAXNode]) -> Bool {
    let identity = policy.identity(
      elementType: elementType,
      label: node.label ?? "",
      identifier: node.identifier ?? "",
      frame: node.rect.cgRect
    )
    if let firstIndex = firstIndexByIdentity[identity] {
      if policy == .tvOS,
        node.focused == true,
        node.type == "Other",
        (node.label != nil || node.identifier != nil),
        node.parentIndex == firstIndex,
        nodes[firstIndex].label == node.label,
        nodes[firstIndex].identifier == node.identifier
      {
        nodes[firstIndex].focused = true
      }
      return false
    }
    firstIndexByIdentity[identity] = node.index
    nodes.append(node)
    return true
  }
}
