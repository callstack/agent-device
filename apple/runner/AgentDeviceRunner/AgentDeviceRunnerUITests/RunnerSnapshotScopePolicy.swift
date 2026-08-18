import Foundation

enum SnapshotScopeSelection: Equatable {
  case unscoped
  case matched(Int)
  case missing
}

/// Cross-runtime snapshot scope specification.
///
/// A non-empty scope selects the first node in presentation preorder whose label, identifier, or
/// value contains the trimmed query case-insensitively. Missing matches publish an empty projection.
enum SnapshotScopePolicy {
  static func select<Node>(
    fromPreorder nodes: [Node],
    scope: String?,
    semanticValues: (Node) -> [String?]
  ) -> SnapshotScopeSelection {
    guard let query = normalized(scope) else { return .unscoped }
    for (index, node) in nodes.enumerated() {
      if semanticValues(node).contains(where: { value in
        value?.lowercased().contains(query) == true
      }) {
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
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct SnapshotScopeFixture: Decodable {
  struct Node: Decodable {
    let depth: Int
    let label: String?
    let identifier: String?
    let value: String?
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
        semanticValues: { [$0.label, $0.identifier, $0.value] }
      )
      let actual: [Int]
      switch selected {
      case .unscoped:
        actual = Array(fixture.nodes.indices)
      case .missing:
        actual = []
      case .matched(let start):
        let rootDepth = fixture.nodes[start].depth
        var end = start + 1
        while end < fixture.nodes.count, fixture.nodes[end].depth > rootDepth {
          end += 1
        }
        actual = Array(start..<end)
      }
      XCTAssertEqual(actual, fixture.expectedSubtreeIndexes, fixture.name)
    }
  }
}
#endif
