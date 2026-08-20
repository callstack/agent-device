import Foundation

enum SnapshotScopeSelection: Equatable {
  case unscoped
  case matched(Int)
  case missing
}

/// Cross-runtime snapshot scope specification.
///
/// A non-empty scope selects the first node in presentation preorder whose label, identifier, or
/// value contains the trimmed query case-insensitively and whose subtree contributes to the
/// requested projection. Missing matches publish an empty projection.
enum SnapshotScopePolicy {
  static func select<Node>(
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

  static func isActive(_ scope: String?) -> Bool {
    normalized(scope) != nil
  }

  private static func normalized(_ scope: String?) -> String? {
    guard let query = scope?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty else {
      return nil
    }
    return query.lowercased()
  }

  static func subtreeRange<Node>(
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
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct SnapshotScopeFixture: Decodable {
  struct Node: Decodable {
    let depth: Int
    let label: String?
    let identifier: String?
    let value: String?
    let presented: Bool?
  }

  let name: String
  let scope: String
  let nodes: [Node]
  let expectedSubtreeIndexes: [Int]
}

extension RunnerTests {
  func testSnapshotScopePolicyMatchesGoldenParityTable() throws {
    // Non-vacuity: label-only semantic values fail the identifier-only and value-only fixtures.
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("snapshot-scope-policy.json")
    let cases = try JSONDecoder().decode(
      [SnapshotScopeFixture].self,
      from: Data(contentsOf: fixtureURL)
    )
    XCTAssertFalse(cases.isEmpty, "parity table must not be empty")

    for fixture in cases {
      let selected = SnapshotScopePolicy.select(
        fromPreorder: fixture.nodes,
        scope: fixture.scope,
        depth: \.depth,
        semanticValues: { [$0.label, $0.identifier, $0.value] },
        subtreeContributes: { range in
          range.contains { fixture.nodes[$0].presented != false }
        }
      )
      let actual: [Int]
      switch selected {
      case .unscoped:
        actual = Array(fixture.nodes.indices)
      case .missing:
        actual = []
      case .matched(let start):
        actual = Array(
          SnapshotScopePolicy.subtreeRange(
            from: start,
            in: fixture.nodes,
            depth: \.depth
          )
        )
      }
      XCTAssertEqual(actual, fixture.expectedSubtreeIndexes, fixture.name)
    }
  }
}
#endif
