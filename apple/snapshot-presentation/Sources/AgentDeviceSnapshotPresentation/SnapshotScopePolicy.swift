import Foundation

public enum SnapshotScopeSelection: Equatable {
  case unscoped
  case matched(Int)
  case missing
}

public enum SnapshotScopePolicy {
  public static func select<Node>(
    fromPreorder nodes: [Node],
    scope: String?,
    depth: (Node) -> Int,
    semanticValues: (Node) -> [String?],
    subtreeContributes: (Range<Int>) -> Bool
  ) -> SnapshotScopeSelection {
    guard let query = normalized(scope) else { return .unscoped }
    for (index, node) in nodes.enumerated() {
      guard semanticValues(node).contains(where: { value in
        value?.lowercased().contains(query) == true
      }) else { continue }
      let range = subtreeRange(from: index, in: nodes, depth: depth)
      if subtreeContributes(range) {
        return .matched(index)
      }
    }
    return .missing
  }

  public static func isActive(_ scope: String?) -> Bool {
    normalized(scope) != nil
  }

  public static func subtreeRange<Node>(
    from start: Int,
    in nodes: [Node],
    depth: (Node) -> Int
  ) -> Range<Int> {
    let rootDepth = depth(nodes[start])
    var end = start + 1
    while end < nodes.count, depth(nodes[end]) > rootDepth {
      end += 1
    }
    return start..<end
  }

  private static func normalized(_ scope: String?) -> String? {
    guard let query = scope?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty else {
      return nil
    }
    return query.lowercased()
  }
}
