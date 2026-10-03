import Foundation
import AgentDeviceSnapshotPresentation

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
      .deletingLastPathComponent() // UnitTests
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
